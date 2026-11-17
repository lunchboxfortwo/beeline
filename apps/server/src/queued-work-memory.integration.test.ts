import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { randomUUID } from 'node:crypto';
import { afterEach, vi } from 'vitest';
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

afterEach(() => vi.unstubAllEnvs());

async function seedMemory() {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await enrollLive();
  const turn = await openTurn('seed-memory');
  await liveDaemon().execute('saveInstitutionalMemory', {
    ...turn, agentId: AGENT, memoryKind: 'workspace_fact',
    canonicalKey: 'deploy.marker', body: 'Release migrations write the marker last.',
    keywords: ['release', 'marker'], sourceMessageIds: [MESSAGE], personAsked: false, confidence: 1,
  }, AGENT);
  await rootFixture.database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,subject_identity_id,canonical_key,body,keywords,source_room_id,source_message_id,audience_kind,confidence,version)
    VALUES(gen_random_uuid(),$1,'human_profile_fact',$2,'private-marker','Other person private marker preference.',
      ARRAY['marker'],$3,$4,'human_profile',1,1)`, [WORKSPACE, OTHER_HUMAN, ROOM, MESSAGE]);
}

async function delivered(reason: string) {
  const queued = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.reason === reason)!;
  expect(queued).toBeDefined();
  expect(queued.source.institutionalContext).toContain('marker last');
  expect(queued.source.institutionalContext).not.toContain('Other person private');
  expect(queued.source.conversationWindow ?? queued.source.conversationContext).toContain('Members (exact tag spellings):');
  expect(itemPrompt(queued, { names: new Map(), fresh: true })).toContain('marker last');
  const wake = (await pendingMcpWakes(rootFixture.database, AGENT)).find(item => item.id === queued.id)!;
  expect(wake.institutionalContext).toBe(
    [queued.source.institutionalContext, queued.source.conversationContext].filter(Boolean).join('\n\n'),
  );
  return queued;
}

it('delivers scheduler context and lets the scheduled turn read and save memory', async () => {
  await seedMemory();
  await rootFixture.database.query(`INSERT INTO agent_schedules
    (id,workspace_id,room_id,agent_id,creator_id,owner_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$5,$5,'{"kind":"interval","everyMinutes":1}',
      'Check the release marker',1,now()-interval '1 second')`, [randomUUID(), WORKSPACE, ROOM, AGENT, HUMAN]);
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
