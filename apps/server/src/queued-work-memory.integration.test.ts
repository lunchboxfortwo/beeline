import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { afterEach, vi } from 'vitest';
import { INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS } from '@beeline/api-contract/daemon';
import { AgentScheduleLoop } from './agent-schedules.js';
import { createAgentSubscription } from './agent-subscriptions.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { itemPrompt } from '../../body/src/place-prompt.js';
import {
  AGENT, HUMAN, OTHER_HUMAN, ROOM, WORKSPACE, MESSAGE,
  rootFixture, enrollLive, liveDaemon, openTurn, startQueuedTurn, expect, it,
} from './test-support-institutional-memory-shadow.test-support.js';

vi.mock('./institutional-memory-embeddings.js', async original => {
  const { INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS } = await import('@beeline/api-contract/daemon');
  return {
    ...await original<typeof import('./institutional-memory-embeddings.js')>(),
    createDefaultEmbedFn: () => async () => ({outcome:'served' as const,
      vector:Array.from({length:INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS},(_,index)=>Number(index===0)),ms:0}),
  };
});

afterEach(() => vi.unstubAllEnvs());

async function seedMemory() {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await enrollLive();
  const turn = await openTurn('seed-memory');
  const seed = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(command=>command.id===turn.requestId)!;
  expect(seed.source.conversationWindow ?? seed.source.conversationContext).toContain('Members (exact tag spellings):');
  await liveDaemon().execute('saveInstitutionalMemory', {
    ...turn, agentId: AGENT, memoryKind: 'workspace_fact',
    canonicalKey: 'deploy.marker', body: 'Release migrations write the marker last.',
    keywords: ['release', 'marker'], sourceMessageIds: [MESSAGE], personAsked: false, confidence: 1,
  }, AGENT);
  await rootFixture.database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,subject_identity_id,canonical_key,body,keywords,source_room_id,source_message_id,audience_kind,confidence,version)
    VALUES(gen_random_uuid(),$1,'human_profile_fact',$2,'private-marker','Other person private marker preference.',
      ARRAY['marker'],$3,$4,'human_profile',1,1)`, [WORKSPACE, OTHER_HUMAN, ROOM, MESSAGE]);
  const vector = Array.from({length:INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS},(_,index)=>Number(index===0));
  await rootFixture.database.query('UPDATE institutional_memory_items SET embedding=$2::vector WHERE workspace_id=$1',
    [WORKSPACE,JSON.stringify(vector)]);
  return turn;
}

async function delivered(reason: string) {
  const queued = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.reason === reason)!;
  expect(queued).toBeDefined();
  expect(queued.source.institutionalContext).toContain('marker last');
  expect(queued.source.institutionalContext).not.toContain('Other person private');
  const conversation = queued.source.conversationWindow ?? queued.source.conversationContext;
  expect(conversation).toContain('Remember that deploy writes the marker last.');
  expect(conversation).not.toContain('Members (exact tag spellings):');
  expect(itemPrompt(queued, { names: new Map(), fresh: true })).toContain('marker last');
  const wake = (await pendingMcpWakes(rootFixture.database, AGENT)).find(item => item.id === queued.id)!;
  expect(wake.institutionalContext).toBe(
    [queued.source.institutionalContext, queued.source.conversationContext].filter(Boolean).join('\n\n'),
  );
  return queued;
}

it('delivers scheduler context and lets the scheduled turn read and save memory', async () => {
  const seed = await seedMemory();
  const schedule = await liveDaemon().execute('createAgentSchedule', {...seed,title:'Check marker',
    prompt:'Check the release marker',cadence:{kind:'interval',everyMinutes:1},maxRuns:1}, AGENT);
  await rootFixture.database.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 second' WHERE id=$1", [schedule.scheduleId]);
  expect(await new AgentScheduleLoop(rootFixture.database).runOnce()).toBe(1);
  const queued = await delivered('schedule');
  expect(queued.from).toEqual({ agent: HUMAN, place: ROOM });
  await startQueuedTurn(rootFixture.database, ROOM, AGENT, queued.id);
  const turn = { roomId: ROOM, requestId: queued.turnRequestId };
  const daemon = liveDaemon();
  expect((await daemon.execute('getInstitutionalContext', turn, AGENT)).text).toContain('marker last');
  await daemon.execute('saveInstitutionalMemory', {
    ...turn, agentId: AGENT, memoryKind: 'workspace_fact', canonicalKey: 'deploy.marker-checked',
    body: 'The release marker was checked by the scheduled turn.', keywords: ['release', 'marker'],
    sourceMessageIds: [queued.sourceMessageId!], personAsked: false, confidence: 1,
  }, AGENT);
  expect((await rootFixture.database.query(`SELECT body FROM institutional_memory_items
    WHERE canonical_key='deploy.marker-checked' AND workspace_id=$1`, [WORKSPACE])).rows)
    .toEqual([{ body: 'The release marker was checked by the scheduled turn.' }]);
  expect((await rootFixture.database.query('SELECT text FROM messages WHERE id=$1', [queued.sourceMessageId])).rows[0]!.text)
    .not.toContain('Memory (quoted notes');
});

it('delivers the same private memory and conversation context for a subscription wake', async () => {
  await seedMemory();
  await createAgentSubscription(rootFixture.database, AGENT, { roomId: ROOM, source: 'room', event: 'joined',
    title: 'Check release', when: 'On member joining', prompt: 'Check the release marker' });
  await ensureSystemIdentity(rootFixture.database);
  await systemLine(rootFixture.database, { roomId: ROOM,
    subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' }, verb: 'recorded', kind: 'joined' });
  await delivered('subscribed_event');
});
