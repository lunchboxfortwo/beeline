import { afterEach, vi } from 'vitest';
import type { CommandRow } from './agent-command.js';
import { createAgentSubscription } from './agent-subscriptions.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { resourceRequester } from './resource-requester.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import {
  AGENT, OTHER_AGENT, HUMAN, OTHER_HUMAN, ROOM, MESSAGE, rootFixture, enrollLive, liveDaemon,
  createAgentCommand, openTurn, startQueuedTurn, expect, it,
} from './test-support-institutional-memory-shadow.test-support.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['schedule', 'subscribed_event'] as const)('%s retains its scheduler’s verified command-only root', async (reason) => {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await enrollLive();
  const seed = await openTurn('seed');
  const daemon = liveDaemon();
  await daemon.execute('saveInstitutionalMemory', {
    ...seed, agentId: AGENT, memoryKind: 'workspace_fact', canonicalKey: 'release.marker',
    body: 'The release marker is stored here.', keywords: ['release', 'marker'],
    sourceMessageIds: [MESSAGE], personAsked: false, confidence: 1,
  }, AGENT);
  await rootFixture.database.query('UPDATE agents SET owner_id=$1 WHERE agent_id=$2', [OTHER_HUMAN, OTHER_AGENT]);
  const root = await createAgentCommand(rootFixture.database, {
    roomId: ROOM, agentId: AGENT, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', authorId: OTHER_AGENT, fromRoomId: ROOM, text: 'Check release marker on schedule and events.' },
  });
  await startQueuedTurn(rootFixture.database, ROOM, AGENT, root!.id);
  const turn = { roomId: ROOM, requestId: root!.turn_request_id };
  if (reason === 'schedule') {
    const saved = await daemon.execute('createAgentSchedule', {
      ...turn, title: 'Release check', prompt: 'Check the release marker', cadence: { kind: 'interval', everyMinutes: 1 },
    }, AGENT);
    await rootFixture.database.query("UPDATE agent_schedules SET next_run_at=now()-interval '1 second' WHERE id=$1", [saved.scheduleId]);
    expect(await new AgentScheduleLoop(rootFixture.database).runOnce()).toBe(1);
  } else {
    await daemon.execute('createAgentSubscription', {
      ...turn, source: 'room', event: 'joined', title: 'Release check', when: 'On joining', prompt: 'Check the release marker',
    }, AGENT);
    await ensureSystemIdentity(rootFixture.database);
    await systemLine(rootFixture.database, { roomId: ROOM,
      subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' }, verb: 'recorded', kind: 'joined' });
  }
  const queued = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.reason === reason)!;
  expect(queued).toBeDefined();
  expect(queued.rootCommandId).toBe(root!.root_command_id);
  expect(queued.rootSourceMessageId).toBe(root!.root_source_message_id);
  expect(queued.source.institutionalContext).toContain('The release marker is stored here.');
  await startQueuedTurn(rootFixture.database, ROOM, AGENT, queued.id);
  const active = { roomId: ROOM, requestId: queued.turnRequestId };
  expect((await daemon.execute('searchInstitutionalMemory', { ...active, query: 'release marker' }, AGENT)).results)
    .toEqual(expect.arrayContaining([expect.objectContaining({ body: 'The release marker is stored here.' })]));
  const stored = (await rootFixture.database.query('SELECT * FROM agent_commands WHERE id=$1', [queued.id])).rows[0];
  expect((await resourceRequester(rootFixture.database, stored as CommandRow))?.requester.id).toBe(OTHER_HUMAN);
  await daemon.execute('saveInstitutionalMemory', {
    ...active, agentId: AGENT, memoryKind: 'workspace_fact', canonicalKey: `release.${reason}`,
    body: 'The release marker was checked.', keywords: ['release'], sourceMessageIds: [MESSAGE],
    personAsked: false, confidence: 1,
  }, AGENT);
});

it('does not borrow an owner for an event subscription created without requester provenance', async () => {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await createAgentSubscription(rootFixture.database, AGENT, { roomId: ROOM, source: 'room', event: 'joined',
    title: 'Release check', when: 'On joining', prompt: 'Check the release marker' });
  await ensureSystemIdentity(rootFixture.database);
  await systemLine(rootFixture.database, { roomId: ROOM,
    subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: 'Beeline' }, verb: 'recorded', kind: 'joined' });
  const queued = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.reason === 'subscribed_event')!;
  const stored = (await rootFixture.database.query('SELECT * FROM agent_commands WHERE id=$1', [queued.id])).rows[0];
  expect((await resourceRequester(rootFixture.database, stored as Parameters<typeof resourceRequester>[1]))?.requester.id).not.toBe(HUMAN);
});
