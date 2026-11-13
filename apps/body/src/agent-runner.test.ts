import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { AgentRunner } from './agent-runner.js';
import { AnswerStore } from './answer-store.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';

const harness = vi.hoisted(() => ({ start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), steer: vi.fn() }));
vi.mock('./place-session.js', () => ({ PlaceSession: class {
  alive = false;
  stale = false;
  start = harness.start;
  deliver = harness.deliver;
  followUp = harness.steer;
  stop = harness.stop;
  cancel() {}
  grantPlace() { return {}; }
  async writeContext() {}
} }));
const roots: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
  harness.start.mockReset().mockResolvedValue(undefined);
  harness.deliver.mockReset().mockResolvedValue({ text: 'answer', steps: [], toolCalls: [], clearDraft: async () => {} });
  harness.stop.mockReset().mockResolvedValue(undefined);
  harness.steer.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'queue-runner-')); roots.push(root);
  const secretKeyHex = '01'.repeat(32);
  const identity = identityFromKey(secretKeyHex, 'Agent');
  const agent = { publicKey: identity.publicKey, secretKeyHex, name: identity.name };
  const runtime = { agent, communityId: 'workspace', rooms: [], supervisorRoot: root } as unknown as AgentRuntimeRecord;
  let changed!: (commands: readonly AgentCommand[]) => void;
  const execute = vi.fn(async (_name: string, _input: Record<string, unknown>) => ({ id: 'posted', createdAt: 1 }));
  const api = { execute,
    setQueueListener: (listener: typeof changed) => { changed = listener; },
    setConfigChangedListener() {}, setRoomsChangedListener() {}, setCornerCompleteListener() {},
  } as unknown as DaemonApiClient;
  new AgentRunner(runtime, join(root, 'runtime.json'), {
    workspaceRoot: root, agentBinary: 'fixture', mcpBinary: 'fixture', agentEnv: {},
  }, { daemonApi: api });
  const item = (id: string): AgentCommand => ({ id, agentId: agent.publicKey, roomId: 'room', returnRoomId: 'room',
    createdAt: 1, turnRequestId: id, action: 'input', reason: 'human_tag', rootCommandId: id,
    rootSourceMessageId: id, sourceMessageId: id, agentDepth: 0,
    source: { id, authorId: 'human', body: id, attachments: [], createdAt: 1, type: 'message' },
  });
  return { root, execute, changed: (commands: AgentCommand[]) => changed(commands), item };
}

it('loads stored answers before delivering a reconnect snapshot to the harness', async () => {
  const loaded = deferred<Awaited<ReturnType<AnswerStore['all']>>>();
  vi.spyOn(AnswerStore.prototype, 'all').mockReturnValue(loaded.promise);
  const f = await fixture(), item = f.item('saved');
  f.changed([item]);
  await Promise.resolve();
  expect(harness.start).not.toHaveBeenCalled();
  loaded.resolve([{ itemId: item.id, roomId: item.roomId, requestId: item.turnRequestId, text: 'stored answer' }]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: 'stored answer' })));
  expect(harness.deliver).not.toHaveBeenCalled();
});

it('retains a refused stored answer and never runs the agent again on another queue snapshot', async () => {
  const f = await fixture(), item = f.item('delivery');
  f.execute.mockImplementation(async name => {
    if (name === 'postRoomMessage' && f.execute.mock.calls.filter(call => call[0] === name).length === 1) throw new Error('optional output read failed');
    return { id: 'posted', createdAt: 1 };
  });
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.anything()));
  expect(JSON.parse(await readFile(join(f.root, 'answers', `${item.id}.json`), 'utf8')).text).toBe('answer');
  // Revoked membership can temporarily hide a still-pending item.
  f.changed([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.parse(await readFile(join(f.root, 'answers', `${item.id}.json`), 'utf8')).text).toBe('answer');
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage')).toHaveLength(2));
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it('posts a stopped-answer notice after a running harness exits, with no redelivery', async () => {
  const f = await fixture(), item = f.item('exited');
  harness.deliver.mockRejectedValueOnce(new Error('signal SIGKILL'));
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    text: 'Agent stopped while answering this: signal SIGKILL', requestId: item.turnRequestId,
  })));
  f.changed([item]);
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it('leaves an unstartable harness item queued for the next connection event', async () => {
  const f = await fixture(), item = f.item('offline');
  harness.start.mockRejectedValueOnce(new Error('missing executable'));
  f.changed([item]);
  await vi.waitFor(() => expect(harness.stop).toHaveBeenCalled());
  expect(f.execute).toHaveBeenCalledWith('startAgentTurn', expect.objectContaining({ available: false }));
  expect(f.execute.mock.calls.some(call => call[0] === 'postRoomMessage')).toBe(false);
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: 'answer' })));
});

it('continues delivering queued input while a stored answer awaits its post acknowledgement', async () => {
  const f = await fixture(), first = f.item('first'), next = f.item('next');
  const posted = deferred<void>();
  f.execute.mockImplementation(async (name, input) => {
    if (name === 'postRoomMessage' && input.requestId === first.turnRequestId) await posted.promise;
    return { id: 'posted', createdAt: 1 };
  });
  f.changed([first]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ requestId: first.turnRequestId })));
  f.changed([first, next]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ requestId: next.turnRequestId })));
  expect(harness.deliver).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(join(f.root, 'answers', `${first.id}.json`), 'utf8')).text).toBe('answer');
  posted.resolve();
  await vi.waitFor(async () => expect(await new AnswerStore(join(f.root, 'answers')).all()).toEqual([]));
});

it('hands a new busy-place item to the active session as follow-up input and answers each item', async () => {
  const f = await fixture(), first = f.item('running'), next = f.item('followup');
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed([first]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  f.changed([first, next]);
  await vi.waitFor(() => expect(harness.steer).toHaveBeenCalledWith(next));
  answering.resolve({ text: 'combined answer', followUps: [next], steps: [], toolCalls: [], clearDraft: async () => {} });
  await vi.waitFor(() => expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage')).toHaveLength(2));
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});
