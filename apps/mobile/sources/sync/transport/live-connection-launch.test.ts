import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ platform: 'web' }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove() {} };
    }
  },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class MonolithRequestTimeoutError extends Error {},
  monolithSession: { authorization: async () => 'launch-access', invalidateAuthorization: vi.fn() },
}));
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
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
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    Socket.instances.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  requests() {
    return this.sent.map((value) => JSON.parse(value)).filter((frame) => frame.t === 'req');
  }
}
const URL = 'ws://fixture.invalid/v1/phone/live';
const roomId = 'launch-room';
const room = { room: { id: roomId }, messages: [] };

function launch(options: { token?: string; url?: string; open?: boolean; received?: { data: string }[] } = {}) {
  const socket = new Socket(options.url ?? URL, [`bearer.${options.token ?? 'launch-access'}`]);
  if (options.open !== false) socket.readyState = 1;
  const release = vi.fn(() => options.received ?? []);
  const page = {
    __beelineLaunchLive: {
      url: options.url ?? URL,
      token: options.token ?? 'launch-access',
      socket,
      release,
    },
  };
  vi.stubGlobal('window', page);
  return { socket, release, page };
}
const connections: LiveConnection[] = [];
function connect() {
  const connection = new LiveConnection({
    authorization: async () => 'launch-access',
    liveUrl: () => URL,
    subscribeIdentityChange: () => () => {},
  });
  connections.push(connection);
  return connection;
}
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  state.platform = 'web';
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([true, false])('adopts the launch socket and sends its own first request (open: %s)', async (open) => {
  const { socket, release } = launch({ open });
  const connection = connect();
  const read = connection.request('readRoom', { roomId });
  await tick();
  expect(Socket.instances).toEqual([socket]);
  expect(release).toHaveBeenCalledOnce();
  if (!open) {
    expect(socket.requests()).toEqual([]);
    socket.open();
  }
  expect(socket.requests()).toHaveLength(1);
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ t: 'req', id: '1', op: 'readRoom', args: { roomId } });
  socket.emit({ t: 'res', id: frame.id, ok: true, result: room });
  await expect(read).resolves.toEqual(room);
  expect(connection.commandState().ready).toBe(true);
});

it('processes frames received before socket adoption', async () => {
  const invalidation = { type: 'invalidate', roomId: '', reason: 'postgres:memberships' };
  const { socket, release } = launch({ received: [{ data: JSON.stringify(invalidation) }] });
  const listener = vi.fn();
  await connect().register([], listener);
  await tick();
  expect(release).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: invalidation });
  expect(socket.sent).toEqual([]);
});

it.each([
  { token: 'old-access' },
  { url: 'ws://other.invalid/v1/phone/live' },
])('closes an incompatible launch socket and connects fresh: %j', async (options) => {
  const { socket, release } = launch(options);
  const read = connect().request('readRoom', { roomId });
  await tick();
  expect(socket.closed).toBe(true);
  expect(release).toHaveBeenCalledOnce();
  const replacement = Socket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  expect(replacement.url).toBe(URL);
  expect(replacement.protocols).toEqual(['bearer.launch-access']);
  replacement.open();
  const [frame] = replacement.requests();
  expect(frame).toMatchObject({ op: 'readRoom', args: { roomId } });
  replacement.emit({ t: 'res', id: frame.id, ok: true, result: room });
  await expect(read).resolves.toEqual(room);
});

it('closes an unadopted launch socket on disposal', () => {
  const { socket, release } = launch();
  connect().dispose();
  expect(socket.closed).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});

it('retires an adopted launch socket on disposal', async () => {
  const { socket } = launch();
  const connection = connect();
  await connection.register([], () => {});
  await tick();
  connection.dispose();
  expect(socket.closed).toBe(true);
});

it('leaves native connections alone', async () => {
  state.platform = 'android';
  const { socket, page, release } = launch();
  const read = connect().request('readRoom', { roomId });
  await tick();
  const native = Socket.instances.at(-1)!;
  expect(native).not.toBe(socket);
  expect(page.__beelineLaunchLive).toBeDefined();
  expect(release).not.toHaveBeenCalled();
  expect(socket.closed).toBe(false);
  native.open();
  const [frame] = native.requests();
  native.emit({ t: 'res', id: frame.id, ok: true, result: room });
  await expect(read).resolves.toEqual(room);
});
