import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ platform: 'web' }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.platform; } }, NativeModules: {},
  NativeEventEmitter: class { addListener() { return { remove() {} }; } },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class MonolithRequestTimeoutError extends Error {},
  monolithSession: { authorization: async () => 'launch-access', invalidateAuthorization: vi.fn() },
}));
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
import { LiveConnection } from './live-connection';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
  requests() { return this.sent.map((value) => JSON.parse(value)).filter((frame) => frame.t === 'req'); }
}
const URL = 'ws://fixture.invalid/v1/phone/live';
const workspaces = { workspaces: [{ id: 'launch-workspace' }] };
const answer = (id: string, result: unknown) => ({ data: JSON.stringify({ t: 'res', id, ok: true, result }) });

/** What index.html leaves for the app: its socket, the sent read and frames received so far. */
function launch(options: { token?: string; open?: boolean; received?: { data: string }[]; path?: string } = {}) {
  const socket = new Socket(URL, [`bearer.${options.token ?? 'launch-access'}`]);
  if (options.open !== false) socket.readyState = 1;
  const release = vi.fn(() => options.received ?? []);
  const page = { location: { pathname: '/beeline/community' }, __beelineLaunchLive: {
    url: URL, token: options.token ?? 'launch-access', path: options.path ?? '/beeline/community', socket,
    reads: [{ id: 'launch-1', op: 'readWorkspaces', args: {} }], release,
  } as unknown };
  vi.stubGlobal('window', page);
  return { socket, release, page };
}
const connections: LiveConnection[] = [];
function connect(token = 'launch-access') {
  const connection = new LiveConnection({ authorization: async () => token, liveUrl: () => URL, subscribeIdentityChange: () => () => {} });
  connections.push(connection);
  return connection;
}
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; state.platform = 'web'; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { for (const connection of connections.splice(0)) connection.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('answers the page first read from the launch socket without a second socket or frame', async () => {
  const { socket, release } = launch({ received: [answer('launch-1', workspaces)] });
  const read = connect().request('readWorkspaces', {});
  await tick();
  await expect(read).resolves.toEqual(workspaces);
  expect(release).toHaveBeenCalledOnce();
  expect(Socket.instances).toEqual([socket]);
  expect(socket.requests()).toEqual([]);
});

it('waits for a launch read still in flight on the adopted socket', async () => {
  const { socket } = launch();
  const read = connect().request('readWorkspaces', {});
  await tick();
  socket.onmessage!(answer('launch-1', workspaces));
  await expect(read).resolves.toEqual(workspaces);
  expect(socket.requests()).toEqual([]);
});

it('keeps an earlier launch answer until the page asks, then serves it once', async () => {
  const { socket } = launch({ received: [answer('launch-1', workspaces)] });
  const connection = connect();
  const other = connection.request('getAuthCapabilities', {});
  await tick();
  expect(socket.requests().map((frame) => frame.op)).toEqual(['getAuthCapabilities']);
  socket.emit({ t: 'res', id: socket.requests()[0].id, ok: true, result: {} });
  await other;
  await expect(connection.request('readWorkspaces', {})).resolves.toEqual(workspaces);
  const again = connection.request('readWorkspaces', {});
  await tick();
  expect(socket.requests().map((frame) => frame.op)).toEqual(['getAuthCapabilities', 'readWorkspaces']);
  socket.emit({ t: 'res', id: socket.requests()[1].id, ok: true, result: { workspaces: [] } });
  await expect(again).resolves.toEqual({ workspaces: [] });
});

it('adopts a launch socket that is still opening', async () => {
  const { socket } = launch({ open: false });
  const connection = connect();
  const read = connection.request('readWorkspaces', {});
  const room = connection.request('readRoom', { roomId: 'launch-room' });
  await tick();
  expect(Socket.instances).toEqual([socket]);
  socket.open();
  expect(socket.requests().map((frame) => frame.op)).toEqual(['readRoom']);
  socket.onmessage!(answer('launch-1', workspaces));
  await expect(read).resolves.toEqual(workspaces);
  expect(connection.commandState().ready).toBe(true);
  void room.catch(() => undefined);
});

it('closes a launch socket opened with another token and sends the read itself', async () => {
  const { socket, release } = launch({ token: 'expired-access', received: [answer('launch-1', workspaces)] });
  const read = connect('renewed-access').request('readWorkspaces', {});
  await tick();
  expect(socket.closed).toBe(true);
  expect(release).toHaveBeenCalled();
  const replacement = Socket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  expect(replacement.protocols).toEqual(['bearer.renewed-access']);
  replacement.open();
  const [frame] = replacement.requests();
  expect(frame).toMatchObject({ op: 'readWorkspaces', args: {} });
  replacement.emit({ t: 'res', id: frame.id, ok: true, result: workspaces });
  await expect(read).resolves.toEqual(workspaces);
});

it('does not answer a read after the page has changed', async () => {
  const { socket, page } = launch({ received: [answer('launch-1', workspaces)] });
  (page as { location: { pathname: string } }).location.pathname = '/beeline/tray';
  const read = connect().request('readWorkspaces', {});
  await tick();
  expect(socket.closed).toBe(true);
  const replacement = Socket.instances.at(-1)!;
  replacement.open();
  expect(replacement.requests().map((frame) => frame.op)).toEqual(['readWorkspaces']);
  replacement.emit({ t: 'res', id: replacement.requests()[0].id, ok: true, result: { workspaces: [] } });
  await expect(read).resolves.toEqual({ workspaces: [] });
});

it('discards an unclaimed launch answer when the socket drops', async () => {
  const { socket } = launch({ received: [answer('launch-1', workspaces)] });
  const connection = connect();
  void connection.request('getAuthCapabilities', {}).catch(() => undefined);
  await tick();
  socket.drop();
  let answered = false;
  const read = connection.request('readWorkspaces', {}).then((value) => { answered = true; return value; });
  await tick();
  const replacement = Socket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  replacement.open();
  await tick();
  expect(answered).toBe(false);
  const own = replacement.requests().filter((frame) => frame.op === 'readWorkspaces');
  for (const frame of own) replacement.emit({ t: 'res', id: frame.id, ok: true, result: { workspaces: [] } });
  await expect(read).resolves.toEqual({ workspaces: [] });
});

it('leaves native connections alone', async () => {
  state.platform = 'android';
  const { socket, page } = launch({ received: [answer('launch-1', workspaces)] });
  void connect().request('readWorkspaces', {}).catch(() => undefined);
  await tick();
  expect(Socket.instances.at(-1)).not.toBe(socket);
  expect((page as { __beelineLaunchLive?: unknown }).__beelineLaunchLive).toBeDefined();
});
