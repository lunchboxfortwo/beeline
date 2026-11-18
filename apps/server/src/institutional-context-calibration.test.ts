import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { INSTITUTIONAL_CONTEXT_VECTOR_MAX_DISTANCE } from '@beeline/api-contract/daemon';
import { getInstitutionalContext, precomputeInstitutionalQueryEmbedding } from './institutional-memory-shadow.js';
import { pgvectorLiteral } from './institutional-memory-embeddings.js';
import {
  it, expect, rootFixture, createAgentCommand, WORKSPACE, ROOM, AGENT, MESSAGE,
} from './test-support-institutional-memory-shadow.test-support.js';

const fixture = JSON.parse(readFileSync(new URL('./test-fixtures/institutional-context-calibration.json', import.meta.url), 'utf8')) as {
  maximumDistance: number;
  notes: Record<string, { body: string; keywords: string[] }>;
  cases: { id: string; text: string; candidates: {
    noteId: string; distance: number | null; relevant: boolean; expectedIncluded: boolean;
  }[] }[];
};

// Preserve the measured cosine distances without committing 50 large query vectors.
// pgvector still performs qualification in the real snapshot SQL.
const vectorAtDistance = (distance: number) => {
  const cosine = 1 - distance;
  return [cosine, Math.sqrt(1 - cosine * cosine), ...new Array(1022).fill(0)];
};

it('locks the approved precision tradeoff on 50 real messages and their 244 delivered notes', async () => {
  expect(INSTITUTIONAL_CONTEXT_VECTOR_MAX_DISTANCE).toBe(0.45);
  expect(fixture.maximumDistance).toBe(0.45);
  expect(fixture.cases).toHaveLength(50);
  const db = rootFixture.database;
  const command = (await createAgentCommand(db, {
    roomId: ROOM, agentId: AGENT, sourceMessageId: MESSAGE, reason: 'human_tag',
  }))!;
  let kept = 0;
  let usefulKept = 0;
  for (const testCase of fixture.cases) {
    await db.query('DELETE FROM institutional_memory_items');
    const rows = testCase.candidates.map(candidate => ({
      id: candidate.noteId, ...fixture.notes[candidate.noteId]!,
      embedding: candidate.distance === null ? null : pgvectorLiteral(vectorAtDistance(candidate.distance)),
    }));
    await db.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,canonical_key,body,keywords,embedding,source_room_id,source_message_id,
       audience_kind,confidence,version)
      SELECT item.id::uuid,$1,'workspace_fact',item.id,item.body,item.keywords,item.embedding::vector,
             $2,$3,'workspace',0.9,1
      FROM jsonb_to_recordset($4::jsonb) item(id text,body text,keywords text[],embedding text)`,
    [WORKSPACE, ROOM, MESSAGE, JSON.stringify(rows)]);
    const embed = vi.fn(async () => ({ outcome: 'served' as const, vector: vectorAtDistance(0), ms: 0 }));
    const context = await getInstitutionalContext(db, {
      ...command, turn_request_id: testCase.id, message: { ...command.message!, body: testCase.text },
    }, embed);
    expect(embed.mock.calls).toEqual([[testCase.text, 'query']]);
    expect([...context.itemIds].sort(), testCase.id).toEqual(testCase.candidates
      .filter(candidate => candidate.expectedIncluded).map(candidate => candidate.noteId).sort());
    kept += context.itemIds.length;
    usefulKept += testCase.candidates.filter(candidate => candidate.relevant && context.itemIds.includes(candidate.noteId)).length;
  }
  expect(fixture.cases.reduce((count, testCase) => count + testCase.candidates.length, 0)).toBe(244);
  expect(kept).toBe(3);
  expect(usefulKept).toBe(1);
});

it('embeds the direct message once, independently of root provenance, brief and roster', async () => {
  const db = rootFixture.database;
  const command = (await createAgentCommand(db, {
    roomId: ROOM, agentId: AGENT, sourceMessageId: MESSAGE, reason: 'human_tag',
  }))!;
  const body = 'Please review the avatar proof.';
  await db.query(`UPDATE agent_commands SET message=message || $2::jsonb WHERE id=$1`, [
    command.id, JSON.stringify({ body, conversationContext: 'Unrelated brief and member roster' }),
  ]);
  const embed = vi.fn(async () => ({ outcome: 'served' as const, vector: vectorAtDistance(0), ms: 0 }));
  const cached = await precomputeInstitutionalQueryEmbedding(db, {
    kind: 'context', roomId: ROOM, agentId: AGENT, requestId: command.turn_request_id,
  }, embed);
  await getInstitutionalContext(db, { ...command, message: { ...command.message!, body } }, cached);
  expect(embed.mock.calls).toEqual([[body, 'query']]);
});
