import type { AgentCommand } from '@beeline/api-contract/daemon';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { AgentRunner } from './agent-runner.js';
import { AnswerStore } from './answer-store.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { identityFromKey,type AgentRuntimeRecord } from './runtime.js';

const harness = vi.hoisted(() => ({ start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), steer: vi.fn(), cancel: vi.fn() }));
vi.mock('./place-session.js', () => ({ PlaceSession: class {
  alive = false;
  stale = false;
  start = harness.start;
  deliver = harness.deliver;
  followUp = harness.steer;
  stop = harness.stop;
  cancel = harness.cancel;
  grantPlace() { return {}; }
  async writeContext() {}
} }));
const roots: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
  harness.start.mockReset().mockResolvedValue(undefined);
  harness.deliver.mockReset().mockResolvedValue({ text: 'answer', steps: [], toolCalls: [], cleanup: async () => {} });
  harness.stop.mockReset().mockResolvedValue(undefined);
  harness.steer.mockReset().mockResolvedValue(undefined);
  harness.cancel.mockReset();
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
  let changed!: (commands: readonly AgentCommand[], completed: readonly string[]) => void;
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
  return { root, execute, changed: (commands: AgentCommand[], completed: readonly string[] = []) => changed(commands, completed), item };
}

it('lets a committed reply finish returning while its harness continues, across later queue pushes', async () => {
  const f = await fixture(), item = f.item('reply-in-progress');
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed([item]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  f.changed([], [item.id]);
  await Promise.resolve();
  f.changed([]);
  await Promise.resolve();
  expect(harness.cancel).not.toHaveBeenCalled();
  answering.resolve({text:'',steps:[],toolCalls:[],cleanup:async()=>{}});
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  expect(f.execute.mock.calls.filter(([name]) => name === 'postRoomMessage')).toEqual([]);
});

it('still cancels Stop while a tool call is running, without mistaking another completed item for its reply', async () => {
  const f = await fixture(), item = f.item('stopped');
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed([item]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  f.changed([], ['another-item']);
  await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledTimes(1));
  answering.resolve({text:'',steps:[],toolCalls:[],cleanup:async()=>{}});
});

it('loads stored answers before delivering a reconnect snapshot to the harness', async () => {
  const loaded = deferred<Awaited<ReturnType<AnswerStore['all']>>>();
  vi.spyOn(AnswerStore.prototype, 'all').mockReturnValue(loaded.promise);
  const f = await fixture(), item = f.item('saved');
  f.changed([item]);
  await Promise.resolve();
  expect(harness.start).not.toHaveBeenCalled();
  loaded.resolve([{ itemId: item.id, roomId: item.roomId, requestId: 'legacy-source-id', text: 'stored answer' }]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: 'stored answer', requestId:item.id })));
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

it('durably closes failed background work without a public answer or redelivery', async () => {
  const f = await fixture(), item = { ...f.item('exited'), reason: 'schedule' };
  harness.deliver.mockRejectedValueOnce(new Error('signal SIGKILL'));
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    text: '', harnessEnded: true, requestId: item.turnRequestId,
  })));
  f.changed([item]);
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it('persists an empty harness cancellation without a failure notice payload', async () => {
  const f = await fixture(), item = f.item('cancelled-without-answer');
  harness.deliver.mockResolvedValueOnce({text:'',stopReason:'cancelled',steps:[],toolCalls:[],cleanup:async()=>{}});
  f.execute.mockImplementation(async name => {
    if (name === 'postRoomMessage') throw new Error('disconnected');
    return {id:'status',createdAt:1};
  });
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId:item.id,text:'',harnessEnded:true,
  })));
  const stored=(await new AnswerStore(join(f.root,'answers')).all())[0];
  expect(stored).toMatchObject({itemId:item.id,text:'',harnessEnded:true});
  expect(stored).not.toHaveProperty('failureReason');
  const closing=f.execute.mock.calls.find(call=>call[0]==='postRoomMessage')![1];
  expect(closing).not.toHaveProperty('failureReason');
});

it('names a sign-in or spent allowance on the failed receipt and nothing else', async () => {
  const f = await fixture();
  harness.deliver.mockRejectedValueOnce(new Error('ACP error -32000: Authentication required'))
    .mockRejectedValueOnce(new Error("You've hit your usage limit. Try again at Sep 19th, 2026 4:09 AM."))
    .mockRejectedValueOnce(new Error('signal SIGKILL'));
  for (const id of ['signed-out', 'limited', 'crashed']) {
    f.changed([f.item(id)]);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ requestId: id, text: '' })));
  }
  const receipts = f.execute.mock.calls.filter(call => call[0] === 'postAgentTurnReceipt' && call[1].outcome === 'failed');
  expect(receipts.map(call => [call[1].requestId, call[1].reasonKind])).toEqual([
    ['signed-out', 'not-signed-in'], ['limited', 'allowance-spent'],
  ]);
  expect(receipts[1]![1].reason).toContain('Sep 19th, 2026 4:09 AM');
  expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage').map(call => call[1].text)).toEqual(['', '', '']);
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

it.each(['end_turn', 'cancelled'])('answers busy-place human input in the next turn after %s', async stopReason => {
  const f = await fixture(), first = f.item('running'), next = f.item('followup');
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed([first]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  f.changed([first, next]);
  await Promise.resolve();
  expect(harness.steer).not.toHaveBeenCalled();
  answering.resolve({ text: '', stopReason, steps: [], toolCalls: [], cleanup: async () => {} });
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(2));
  expect(harness.deliver).toHaveBeenLastCalledWith(next, [next]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: next.id, text: 'answer',
  })));
  expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage' && call[1].requestId === next.id && call[1].text === '')).toEqual([]);
});

it('answers all input waiting in a busy place with one batch publication', async () => {
  const f = await fixture(), first = f.item('running');
  const waiting = [f.item('followup-one'), f.item('followup-two')];
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed([first]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  f.changed([first, ...waiting]);
  await Promise.resolve();
  answering.resolve({ text: 'First answer', steps: [], toolCalls: [], cleanup: async () => {} });
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: waiting[0]!.id, queuedRequestIds: [waiting[1]!.id], text: 'answer',
  })));
  expect(harness.deliver).toHaveBeenCalledTimes(2);
  expect(harness.deliver).toHaveBeenLastCalledWith(waiting[0], waiting);
});

it('posts an already stored answer when the outbox becomes unwritable afterwards', async () => {
  const save = AnswerStore.prototype.save;
  let writable = true;
  vi.spyOn(AnswerStore.prototype, 'save').mockImplementation(async function (answer) {
    if (!writable) throw new Error('outbox became read-only');
    await save.call(this, answer);
    writable = false;
  });
  const f = await fixture();
  f.changed([f.item('stored-before-readonly')]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: 'answer' })));
});


it('sends empty closing text through the answer exit and retains it while no answer exists',async()=>{
  const f=await fixture(),item={...f.item('empty-closing'),reason:'schedule'};
  harness.deliver.mockResolvedValueOnce({text:'',steps:[],toolCalls:[],cleanup:async()=>{}});
  f.execute.mockImplementation(async name=>name==='postRoomMessage'?{id:'owed',createdAt:1,answered:false}:{id:'status',createdAt:1});
  f.changed([item]);
  await vi.waitFor(()=>expect(f.execute).toHaveBeenCalledWith('postRoomMessage',expect.objectContaining({text:'',requestId:item.turnRequestId})));
  expect((await new AnswerStore(join(f.root,'answers')).all()).map(answer=>answer.itemId)).toEqual([item.id]);
  expect(f.execute.mock.calls.some(call=>call[0]==='markAgentTurnSilent')).toBe(false);
  f.execute.mockResolvedValue({id:'posted',createdAt:1});
  f.changed([item]);
  await vi.waitFor(async()=>expect(await new AnswerStore(join(f.root,'answers')).all()).toEqual([]));
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it.each(['end_turn', 'cancelled'])('closes only background items in an empty reconnect batch after %s', async stopReason => {
  const f = await fixture(), offlineSeconds = 18 * 3600;
  const tag = { ...f.item('tag'), offlineSeconds };
  const schedule = { ...f.item('schedule'), offlineSeconds, reason: 'schedule', scheduleId: 'errors' };
  const event = { ...f.item('event'), offlineSeconds, reason: 'subscribed_event' };
  harness.deliver.mockResolvedValueOnce({ text: '', steps: [], stopReason, toolCalls: [], cleanup: async () => {} });
  f.execute.mockImplementation(async (_name, input) => ({ id: 'receipt', createdAt: 1,
    ...(_name === 'postRoomMessage' && !input.text ? { answered: false } : {}) }));
  f.changed([schedule, tag, event]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: schedule.id, queuedRequestIds: [tag.id, event.id], text: '', harnessEnded: true })));
  await vi.waitFor(async () => expect(await new AnswerStore(join(f.root, 'answers')).all()).toEqual([]));
  f.changed([tag]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: tag.id, text: 'answer',
  })));
  expect(harness.deliver).toHaveBeenCalledTimes(2);
});

it('keeps the genuine answer durable when optional cleanup fails', async () => {
  const saved=vi.spyOn(AnswerStore.prototype,'save');
  const cleanup=vi.fn(async()=>{
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({text:'The genuine answer'}));
    throw new Error('cleanup EACCES');
  });
  harness.deliver.mockResolvedValueOnce({text:'The genuine answer',steps:[],toolCalls:[],cleanup});
  const f=await fixture(),item=f.item('cleanup');
  f.execute.mockImplementation(async name=>{
    if(name==='postRoomMessage')throw new Error('disconnected');
    return {id:'posted',createdAt:1};
  });
  f.changed([item]);
  await vi.waitFor(()=>expect(cleanup).toHaveBeenCalledTimes(1));
  expect(JSON.parse(await readFile(join(f.root,'answers',`${item.id}.json`),'utf8')).text).toBe('The genuine answer');
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it('stores and posts one answer for every item in an offline chat batch', async () => {
  const f = await fixture();
  const batch = Array.from({ length: 28 }, (_, n) => ({ ...f.item(`offline-${n}`),
    offlineSeconds: 18 * 3600,
    ...(n >= 3 ? { reason: 'schedule', scheduleId: 'one-schedule' } : {}),
  }));
  const answering = deferred<Record<string, unknown>>();
  harness.deliver.mockReturnValueOnce(answering.promise);
  f.changed(batch);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(1));
  expect(harness.deliver).toHaveBeenCalledWith(batch[0], batch);
  expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage')).toHaveLength(0);
  f.execute.mockImplementation(async name => {
    if (name === 'postRoomMessage') throw new Error('disconnected before publication');
    return { id: 'status', createdAt: 1 };
  });
  answering.resolve({ text: 'Answers for all three askers and the latest schedule', steps: [], toolCalls: [], cleanup: async () => {} });
  await vi.waitFor(() => expect(f.execute.mock.calls.filter(call => call[0] === 'postRoomMessage')).toHaveLength(1));
  expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: batch[0]!.id, queuedRequestIds: batch.slice(1).map(item => item.id),
  }));
  expect((await new AnswerStore(join(f.root, 'answers')).all())[0]?.queuedRequestIds).toHaveLength(27);
  f.execute.mockResolvedValue({ id: 'combined-answer', createdAt: 1 });
  f.changed(batch);
  await vi.waitFor(async () => expect(await new AnswerStore(join(f.root, 'answers')).all()).toEqual([]));
  expect(harness.deliver).toHaveBeenCalledTimes(1);
  expect(harness.steer).not.toHaveBeenCalled();
});

it('restores every item covered by a stored batch answer without asking the harness again', async () => {
  vi.spyOn(AnswerStore.prototype, 'all').mockResolvedValueOnce([{
    itemId: 'first', queuedRequestIds: ['second', 'third'], roomId: 'room', requestId: 'first', text: 'combined answer',
  }]);
  const f = await fixture();
  f.changed(['first', 'second', 'third'].map(f.item));
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: 'first', queuedRequestIds: ['second', 'third'], text: 'combined answer',
  })));
  expect(harness.deliver).not.toHaveBeenCalled();
});

it('batches pending input in its own chat, including live input after reconnect', async () => {
  const f = await fixture();
  const offlineSeconds = 18*3600;
  const first = {...f.item('room-one'),offlineSeconds};
  const second = {...f.item('room-two'),roomId:'another-room',returnRoomId:'another-room',offlineSeconds};
  const live = f.item('live-after-reconnect');
  f.changed([first,second,live]);
  await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledTimes(2));
  expect(harness.deliver).toHaveBeenCalledWith(first,[first,live]);
  expect(harness.deliver).toHaveBeenCalledWith(second,[second]);
});

it('replays a durable empty harness completion without running the agent again', async () => {
  vi.spyOn(AnswerStore.prototype, 'all').mockResolvedValueOnce([{
    itemId: 'silent', roomId: 'room', requestId: 'silent', text: '', harnessEnded: true,
  }]);
  const f = await fixture();
  f.changed([f.item('silent')]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: 'silent', text: '', harnessEnded: true,
  })));
  expect(harness.deliver).not.toHaveBeenCalled();
});

it('lets a refused legacy empty human completion run on the next queue delivery', async () => {
  vi.spyOn(AnswerStore.prototype, 'all').mockResolvedValueOnce([{
    itemId: 'unanswered', roomId: 'room', requestId: 'unanswered', text: '', harnessEnded: true,
  }]);
  const f = await fixture(), item = f.item('unanswered');
  f.execute.mockImplementation(async (_name, input) => ({ id: 'receipt', createdAt: 1,
    ...(_name === 'postRoomMessage' && !input.text ? { answered: false } : {}) }));
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({ text: '' })));
  await vi.waitFor(async () => expect(await new AnswerStore(join(f.root, 'answers')).all()).toEqual([]));
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: item.id, text: 'answer',
  })));
  expect(harness.deliver).toHaveBeenCalledTimes(1);
});

it('retires a generated failure notice restored from an older helper outbox', async () => {
  vi.spyOn(AnswerStore.prototype, 'all').mockResolvedValueOnce([{
    itemId: 'legacy', roomId: 'room', requestId: 'legacy',
    text: 'Agent stopped while answering this: signal SIGKILL',
  }]);
  const f = await fixture();
  f.changed([f.item('legacy')]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('postRoomMessage', expect.objectContaining({
    requestId: 'legacy', text: '', harnessEnded: true,
  })));
  expect(harness.deliver).not.toHaveBeenCalled();
});

it('ends a hosted item with the real startup failure and does not replay it on reconnect', async () => {
  const f = await fixture();
  const item = { ...f.item('first-hosted'), modelCredential: {
    v: 1 as const, token: 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64), expiresAt: null,
  } };
  harness.start.mockRejectedValueOnce(new Error('ACP error -32000: Authentication required: Configure an API key or log in'));
  f.changed([item]);
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith('startAgentTurn', {
    roomId: item.roomId, requestId: item.id, available: false,
    failureReason: expect.stringContaining('Authentication required'),
  }));
  f.changed([item]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(harness.deliver).not.toHaveBeenCalled();
});
