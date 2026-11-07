import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ currentState: 'active', platform: 'android', listeners: new Set<(value: string) => void>(), network: new Set<(value: { isConnected: boolean; isInternetReachable: boolean }) => void>() }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.platform; } }, NativeModules: { RNCNetInfo: {} },
  NativeEventEmitter: class { addListener(_name: string, listener: (value: { isConnected: boolean; isInternetReachable: boolean }) => void) {
    state.network.add(listener); return { remove: () => state.network.delete(listener) };
  } }, AppState: { get currentState() { return state.currentState; },
  addEventListener: (_event: string, listener: (value: string) => void) => {
    state.listeners.add(listener); return { remove: () => state.listeners.delete(listener) };
  } } }));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class MonolithRequestTimeoutError extends Error {},
  MonolithSessionChangedError: class MonolithSessionChangedError extends Error {},
  monolithSession: { authorization: async () => 'fixture-access', invalidateAuthorization: vi.fn() },
}));
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
import { LiveConnection, useConnectionFailure, subscribeNetworkOnline, sharedLiveConnection, resetSharedLiveConnection, reconnectNow } from './live-connection';
import { PhoneSocketDisconnectedError } from './phone-socket-error';
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { createDiagnosticClient } from '@beeline/api-contract/diagnostics-client';
import { randomUUID } from 'node:crypto';

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  autoPong = true;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); if (frame === '{"type":"ping"}' && this.autoPong) this.emit({type:'pong'}); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(frame: unknown) { this.onmessage?.({data:JSON.stringify(frame)}); }
  drop() { this.readyState = 3; this.onclose?.(); }
  fail() { this.onerror?.(); }
  requests() { return this.sent.map(value=>JSON.parse(value)).filter(frame=>frame.t==='req'); }
  reply(result: unknown, index = 0) { this.emit({t:'res',id:this.requests()[index].id,ok:true,result}); }
  refuse(index = 0) { this.emit({t:'res',id:this.requests()[index].id,ok:false,error:{code:'unavailable',message:'Read unavailable',retryable:true}}); }
}
const connections: LiveConnection[] = [];
function setup(authorization = vi.fn(async () => 'fixture-access')) {
  let changed = () => {};
  const invalidate = vi.fn();
  const connection = new LiveConnection({ authorization, invalidateAuthorization:invalidate,
    subscribeNetworkOnline, liveUrl:()=> 'ws://fixture.invalid/v1/phone/live', subscribeIdentityChange: listener => { changed=listener; return ()=>{}; } });
  connections.push(connection);
  return {connection,authorization,invalidate,changeIdentity:()=>changed()};
}
const tick = () => vi.advanceTimersByTimeAsync(0);

it('does not attribute an old account request outcome to the next account',async()=>{
  let changed=()=>{};
  const record=vi.fn();
  const connection=new LiveConnection({authorization:async()=> 'fixture-access',liveUrl:()=> 'ws://fixture.invalid/v1/phone/live',
    subscribeIdentityChange:listener=>{changed=listener;return()=>{};},
    telemetry:{origin:()=>undefined,record,flush:()=>{}}});
  connections.push(connection);
  const old=connection.request('readRoom',{roomId:'old-account-room'}).catch(error=>error);
  await open();changed();await old;
  expect(record.mock.calls.some(([step])=>step.name==='operation_failed')).toBe(false);
  const current=connection.request('readWorkspaces',{});
  const socket=await open();socket.reply([]);await current;
  expect(record.mock.calls.filter(([step])=>step.name==='operation_completed').map(([step])=>step.operation)).toEqual(['readWorkspaces']);
});

it('acceptance 8: batches share the established socket, never recurse, poll or wait on ingestion before completing an action',async()=>{
  const values=new Map<string,string>();
  let connection!: LiveConnection;
  const telemetry=createDiagnosticClient({storage:{getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);},getAllKeys:async()=>[...values.keys()],removeItem:async k=>{values.delete(k);}},
    uuid:randomUUID,descriptor:{platform:'android',client:'expo_native',version:'0.2.22',environment:'lab'},
    send:async batch=>{
      if(!connection.commandState().ready)throw new Error('offline');
      return connection.request('reportDiagnostics',batch);
    }});
  await telemetry.identify('fixture-viewer');
  const origin=await telemetry.context();
  connection=new LiveConnection({authorization:async()=> 'fixture-access',liveUrl:()=> 'ws://fixture.invalid/v1/phone/live',subscribeIdentityChange:()=>()=>{},
    telemetry:{origin:()=>({...origin,requestId:randomUUID()}),record:step=>{void telemetry.record(step);},flush:()=>{void telemetry.flush();}}});
  connections.push(connection);
  const action=connection.request('readWorkspaces',{});
  const socket=await open();await tick();
  const domain=socket.requests().find(r=>r.op==='readWorkspaces');
  expect(domain.diagnostic).toEqual(expect.objectContaining({sessionId:expect.any(String),actionId:expect.any(String)}));
  socket.emit({t:'res',id:domain.id,ok:true,result:[]});
  await expect(action).resolves.toEqual([]); // Telemetry acknowledgement is still withheld.
  await tick();
  expect(Socket.instances).toHaveLength(1);
  const batches=socket.requests().filter(r=>r.op==='reportDiagnostics');
  expect(batches).toHaveLength(1);
  expect(batches[0].args.events.length).toBeLessThanOrEqual(32);
  for(let i=0;i<4;i++) {
    const unanswered=socket.requests().filter(r=>r.op==='reportDiagnostics' && !r.acknowledged);
    for(const r of unanswered) { r.acknowledged=true;socket.emit({t:'res',id:r.id,ok:true,result:{accepted:r.args.events.map((e:{eventId:string})=>e.eventId)}}); }
    await tick();
  }
  const before=socket.sent.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.sent).toHaveLength(before);
  expect(Socket.instances).toHaveLength(1);
  const events=socket.requests().filter(r=>r.op==='reportDiagnostics').flatMap(r=>r.args.events);
  expect(events.some(e=>e.operation==='reportDiagnostics')).toBe(false);
});
async function open() { await tick(); const socket=Socket.instances.at(-1)!;socket.open();return socket; }
function appState(next: string) { state.currentState=next;for(const listener of state.listeners)listener(next); }
beforeEach(()=>{vi.useFakeTimers();Socket.instances=[];state.currentState='active';state.platform='android';vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{resetSharedLiveConnection();for(const connection of connections.splice(0))connection.dispose();state.listeners.clear();vi.useRealTimers();vi.unstubAllGlobals();});

async function recoverRead(result: unknown = { room: { id: 'a' } }) {
  const replacement = await open();
  expect(useConnectionFailure()).toBe(false);
  expect(replacement.requests().map(frame => frame.op)).toEqual(['readWorkspaces']);
  replacement.reply({ workspaces: [] });
  await tick();
  replacement.reply(result, 1);
  return replacement;
}
async function failRecovery() {
  await tick();
  Socket.instances.at(-1)!.fail();
  await tick();
}

describe('the one phone socket', () => {
  it('reconnects once and rereads without ever announcing a recovered blip', async () => {
    const { connection, invalidate } = setup();
    const read = connection.request('readRoom', { roomId: 'a' });
    const first = await open(); first.drop();
    expect(useConnectionFailure()).toBe(false);
    await recoverRead();
    await expect(read).resolves.toEqual({ room: { id: 'a' } });
    expect(Socket.instances).toHaveLength(2);
    expect(invalidate).not.toHaveBeenCalled();
    expect(useConnectionFailure()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['open', 'read'] as const)('shows one failure only when the replacement %s fails, with no third attempt', async stage => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop();
    if (stage === 'read') await open();
    await failRecovery();
    expect(await read).toBeInstanceOf(PhoneSocketDisconnectedError);
    expect(useConnectionFailure()).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(Socket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    const next = connection.request('readRoom', { roomId: 'a' });
    const socket = await open(); socket.reply({}); await next;
    expect(useConnectionFailure()).toBe(false);
  });
  it('initial socket admission gets only one replacement', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    await tick(); Socket.instances[0].fail();
    expect(useConnectionFailure()).toBe(false);
    await failRecovery();
    expect(await read).toBeInstanceOf(PhoneSocketDisconnectedError);
    expect(Socket.instances).toHaveLength(2); expect(useConnectionFailure()).toBe(true);
  });
  it('shares one replacement and confirming read across concurrent failures', async () => {
    const { connection } = setup();
    const room = connection.request('readRoom', { roomId: 'a' });
    const list = connection.request('readWorkspaces', {});
    (await open()).drop();
    const socket = await open();
    expect(socket.requests()).toHaveLength(1);
    socket.reply({ workspaces: [] }); await tick();
    expect(socket.requests().map(frame => frame.op)).toEqual(['readWorkspaces', 'readRoom', 'readWorkspaces']);
    socket.reply({ workspaces: [] }, 2); socket.reply({}, 1);
    await room; await list;
    expect(Socket.instances).toHaveLength(2); expect(useConnectionFailure()).toBe(false);
  });
  it('a failed confirming read shared by several screens never starts a third socket', async () => {
    const { connection } = setup();
    const room = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    const list = connection.request('readWorkspaces', {}).catch(error => error);
    (await open()).drop(); await open(); await failRecovery();
    await room; await list;
    expect(Socket.instances).toHaveLength(2); expect(useConnectionFailure()).toBe(true);
  });
  it.each(['reactToMessage', 'sendRoomMessage', 'sendRoomReply'] as const)('does not replay an uncertain %s; it confirms connectivity with a read', async operation => {
    const { connection } = setup();
    const write = connection.request(operation, { roomId: 'a', messageId: 'm', emoji: '👍', text: 'Hello', parentMessageId: 'parent' }).catch(error => error);
    const first = await open(); first.drop();
    const replacement = await open(); replacement.reply({ workspaces: [] });
    expect(await write).toBeInstanceOf(PhoneSocketDisconnectedError);
    expect(replacement.requests().map(frame => frame.op)).toEqual(['readWorkspaces']);
    expect(useConnectionFailure()).toBe(false);
  });
  it('a socket write exception uses the same one replacement budget', async () => {
    const { connection } = setup(); await connection.register([], () => {});
    const socket = await open(); socket.send = () => { throw Error('write failed'); };
    const write = connection.request('reactToMessage', { roomId: 'a', messageId: 'm', emoji: '👍' }).catch(error => error);
    await failRecovery(); await write;
    expect(useConnectionFailure()).toBe(true); expect(Socket.instances).toHaveLength(2);
  });
  it('a failed reread cannot silently create another reconnect', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop(); const socket = await open(); socket.reply({}); await tick(); socket.drop();
    await read; await tick();
    expect(useConnectionFailure()).toBe(true); expect(Socket.instances).toHaveLength(2);
  });
  it.each(['readRoom', 'reactToMessage'] as const)('%s deadlines never infer an outage or reconnect', async operation => {
    const { connection } = setup();
    const read = connection.request(operation, { roomId: 'a', messageId: 'm', emoji: '👍' }, { timeoutMs: 100 }).catch(error => error);
    const socket = await open();
    const join = connection.request('voiceJoin', { roomId: 'a' });
    await vi.advanceTimersByTimeAsync(100);
    expect(await read).toBeInstanceOf(MonolithRequestTimeoutError);
    expect(useConnectionFailure()).toBe(false); expect(socket.readyState).toBe(1);
    socket.reply({ call: { id: 'call' } }, 1); await join;
    expect(Socket.instances).toHaveLength(1);
  });
  it('a confirming read deadline never diagnoses a broken socket or schedules another attempt', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop(); const replacement = await open();
    await vi.advanceTimersByTimeAsync(20_000); await read;
    expect(useConnectionFailure()).toBe(false); expect(Socket.instances).toHaveLength(2);
    expect(replacement.readyState).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('returns server refusals once without reconnecting', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    const socket = await open(); socket.refuse();
    expect(await read).toMatchObject({ code: 'unavailable' });
    expect(useConnectionFailure()).toBe(false); expect(Socket.instances).toHaveLength(1);
  });
  it('a server refusal on the confirming read proves the socket answered', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop(); (await open()).refuse(); await read;
    expect(useConnectionFailure()).toBe(false); expect(Socket.instances).toHaveLength(2);
  });
  it('invalidates credentials only on the explicit authorization refusal', async () => {
    const { connection, invalidate } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    const socket = await open();
    socket.emit({ t: 'res', id: socket.requests()[0].id, ok: false, error: { code: 'unauthorized', message: 'Sign in again', retryable: false } });
    expect(await read).toMatchObject({ code: 'unauthorized' }); expect(invalidate).toHaveBeenCalledWith('fixture-access');
    expect(Socket.instances).toHaveLength(1); expect(useConnectionFailure()).toBe(false);
  });
  it('authorization failures and deadlines before socket admission cannot infer connectivity', async () => {
    const { connection } = setup(vi.fn(async () => { throw new MonolithRequestTimeoutError(); }));
    await expect(connection.request('readRoom', { roomId: 'a' })).rejects.toBeInstanceOf(MonolithRequestTimeoutError);
    expect(Socket.instances).toHaveLength(0); expect(useConnectionFailure()).toBe(false);
  });
  it('never retries background or old-identity work', async () => {
    const { connection, changeIdentity } = setup();
    const old = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()); changeIdentity(); await old;
    expect(Socket.instances).toHaveLength(1); expect(useConnectionFailure()).toBe(false);
    const read = connection.request('readRoom', { roomId: 'b' }).catch(error => error);
    const socket = await open(); appState('background'); socket.drop(); await read;
    expect(Socket.instances).toHaveLength(2); expect(useConnectionFailure()).toBe(false);
  });
  it('an identity change during reconnect cannot replay the old read or show an old failure', async () => {
    const { connection, changeIdentity } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop(); await open(); changeIdentity(); await read;
    expect(useConnectionFailure()).toBe(false); expect(Socket.instances).toHaveLength(2);
  });
  it('a new foreground session clears an old confirmed failure', async () => {
    const { connection } = setup();
    const read = connection.request('readRoom', { roomId: 'a' }).catch(error => error);
    (await open()).drop(); await failRecovery(); await read;
    expect(useConnectionFailure()).toBe(true);
    appState('background'); appState('active'); expect(useConnectionFailure()).toBe(false);
  });
  it('abort does not close the shared socket or reconnect', async () => {
    const { connection } = setup(); const cancel = new AbortController();
    const read = connection.request('readRoom', { roomId: 'a' }, { signal: cancel.signal }).catch(error => error);
    const socket = await open(); const other = connection.request('readWorkspaces', {}); cancel.abort();
    expect(await read).toMatchObject({ name: 'AbortError' }); socket.reply({}, 1); await other;
    expect(Socket.instances).toHaveLength(1); expect(useConnectionFailure()).toBe(false);
  });
  it('idle time, offline signals and missing heartbeats never infer failure', async () => {
    const { connection } = setup(); await connection.register([], () => {}); const socket = await open();
    for (const listener of state.network) listener({ isConnected: false, isInternetReachable: false });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(socket.sent).not.toContain('{"type":"ping"}'); expect(useConnectionFailure()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); expect(Socket.instances).toHaveLength(1);
  });
  it('online and foreground events invoke the subscribed read without probes', async () => {
    const { connection } = setup(); const listener = vi.fn(); await connection.register([{ '#h': ['a'] }], listener); await open();
    for (const online of state.network) online({ isConnected: true, isInternetReachable: true });
    appState('background'); appState('active');
    expect(listener).toHaveBeenCalledTimes(2); expect(Socket.instances).toHaveLength(1);
  });
  it('idle socket failure asks the screen to read, but does not itself show a banner', async () => {
    const { connection } = setup(); const listener = vi.fn(); await connection.register([{ '#h': ['a'] }], listener);
    (await open()).drop(); expect(listener).toHaveBeenCalledOnce(); expect(useConnectionFailure()).toBe(false);
  });
  it('a native-closed socket without its callback is replaced by the next read', async () => {
    const { connection } = setup(); await connection.register([], () => {}); const first = await open(); first.readyState = 3;
    const read = connection.request('readRoom', { roomId: 'a' }); const next = await open(); next.reply({}); await read;
    expect(next).not.toBe(first); expect(useConnectionFailure()).toBe(false);
  });
  it('preserves Room subscriptions and view ownership across replacement', async () => {
    const { connection } = setup(); const stop = await connection.register([{ '#h': ['a'] }], () => {});
    const first = await open(); const release = connection.view('a'); const read = connection.request('readRoom', { roomId: 'a' });
    first.drop(); const next = await recoverRead(); await read;
    expect(next.sent.map(value => JSON.parse(value))).toContainEqual({ type: 'viewing', roomId: 'a', viewing: true });
    release(); stop(); expect(next.sent.map(value => JSON.parse(value))).toContainEqual({ type: 'unsubscribe', roomId: 'a' });
  });
  it('delivers live events as-is without a client replay cache', async () => {
    const { connection } = setup(); const first = vi.fn(); await connection.register([{ '#h': ['a'] }], first); const socket = await open();
    const event = { type: 'draft', roomId: 'a', agentId: 'agent', turnId: 'turn', text: 'Current text' };
    socket.emit(event); expect(first).toHaveBeenCalledWith({ monolithLive: event });
    const later = vi.fn(); await connection.register([{ '#h': ['a'] }], later); expect(later).not.toHaveBeenCalled();
  });
  it('the shared production owner removes native online listeners on dispose', () => {
    sharedLiveConnection(); expect(state.network.size).toBe(1); resetSharedLiveConnection(); expect(state.network.size).toBe(0);
  });
});

describe('unchanged socket ownership guarantees', () => {
it('an old request deadline cannot announce a failure after resume', async () => {
    const { connection } = setup();
    const old = connection.request('readRoom', { roomId: 'a' }, { timeoutMs: 100 }).catch(error => error);
    const socket = await open();
    appState('background'); appState('active');
    await vi.advanceTimersByTimeAsync(100); await old;
    expect(useConnectionFailure()).toBe(false);
    const read = connection.request('readRoom', { roomId: 'a' });
    socket.reply({}, 1); await read;
    expect(useConnectionFailure()).toBe(false);
  });
it('a request deadline waiting for authorization cannot announce a socket failure', async () => {
    const { connection } = setup(vi.fn(() => new Promise<string>(() => {})));
    const read = connection.request('readRoom', { roomId: 'a' }, { timeoutMs: 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await read).toBeInstanceOf(MonolithRequestTimeoutError);
    expect(Socket.instances).toHaveLength(0);
    expect(useConnectionFailure()).toBe(false);
  });
it('browser online invokes the same read and disposal removes its listener',async()=>{
    state.platform='web';const browser=new EventTarget();vi.stubGlobal('window',browser);
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);await open();
    browser.dispatchEvent(new Event('online'));expect(listener).toHaveBeenCalledTimes(1);
    connection.dispose();browser.dispatchEvent(new Event('online'));expect(listener).toHaveBeenCalledTimes(1);
  });
it('a rejected image metadata read cannot disconnect a send awaiting its acknowledgement',async()=>{
    const {connection}=setup();const send=connection.request('sendRoomMessage',{roomId:'a',messageId:'image',text:''});
    const socket=await open();const metadata=connection.request('readMediaMetadata',{objectId:'media'}).catch(error=>error);
    socket.emit({t:'res',id:socket.requests()[1].id,ok:false,error:{code:'unknown_phone_operation',message:'unknown_phone_operation',retryable:false}});
    expect(await metadata).toMatchObject({code:'unknown_phone_operation'});
    expect(socket.readyState).toBe(1);expect(useConnectionFailure()).toBe(false);
    socket.reply({messageId:'image'});await expect(send).resolves.toEqual({messageId:'image'});
    expect(Socket.instances).toHaveLength(1);
  });
it('never opens with authorization completed after sign-out',async()=>{
    let release!:(token:string)=>void;const authorization=vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}));const {connection,changeIdentity}=setup(authorization);
    await connection.register([],()=>{});changeIdentity();release('old-access');await tick();expect(Socket.instances).toHaveLength(0);
  });
it('an old view release cannot hide the new identity’s view',async()=>{
    const {connection,changeIdentity}=setup();await connection.register([],()=>{});await open();const oldRelease=connection.view('a');changeIdentity();
    connection.reconnectNow();const socket=await open();connection.view('a');oldRelease();
    expect(socket.sent.map(value=>JSON.parse(value)).filter(frame=>frame.type==='viewing')).toEqual([{type:'viewing',roomId:'a',viewing:true}]);
  });
it('subscribes open Rooms without resume cursors and asks the server again for a joining screen',async()=>{
    const {connection}=setup();const listener=vi.fn();const stop=await connection.register([{'#h':['a']}],listener);const socket=await open();
    expect(socket.sent.map(value=>JSON.parse(value))[0]).toEqual({type:'subscribe',roomIds:['a'],sidebarPreviews:true,roomStateProjections:true});
    const other=await connection.register([{'#h':['a']}],()=>{});expect(socket.sent.map(value=>JSON.parse(value)).filter(frame=>frame.type==='subscribe')).toHaveLength(2);
    stop();expect(socket.sent.some(value=>JSON.parse(value).type==='unsubscribe')).toBe(false);other();expect(socket.sent.some(value=>JSON.parse(value).type==='unsubscribe')).toBe(true);
  });
});
