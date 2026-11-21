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
const workspaces = { workspaces: [{ id: 'launch-workspace' }] };
const answer = (id: string, result: unknown) => ({
  data: JSON.stringify({ t: 'res', id, ok: true, result }),
});

/** What index.html leaves for the app: its socket, the sent read and frames received so far. */
function launch(
  options: { token?: string; open?: boolean; received?: { data: string }[]; path?: string; roomId?: string; unsent?: boolean } = {},
) {
  const socket = new Socket(URL, [`bearer.${options.token ?? 'launch-access'}`]);
  if (options.open !== false) socket.readyState = 1;
  const release = vi.fn(() => options.received ?? []);
  const page = {
    location: { pathname: options.roomId ? '/beeline/chat/' + options.roomId : '/beeline/community' },
    __beelineLaunchLive: {
      url: URL,
      token: options.token ?? 'launch-access',
      path: options.path ?? (options.roomId ? '/beeline/chat/' + options.roomId : '/beeline/community'),
      socket,
      reads: options.unsent || options.open === false ? [] : [{ id: 'launch-1', op: options.roomId ? 'readRoom' : 'readWorkspaces', args: options.roomId ? { roomId: options.roomId } : {} }],
      release,
    } as unknown,
  };
  vi.stubGlobal('window', page);
  return { socket, release, page };
}
const connections: LiveConnection[] = [];
function connect(token = 'launch-access') {
  const connection = new LiveConnection({
    authorization: async () => token,
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
  expect(socket.requests().map((frame) => frame.op)).toEqual([
    'getAuthCapabilities',
    'readWorkspaces',
  ]);
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
  expect(socket.requests().map((frame) => frame.op)).toEqual(['readWorkspaces', 'readRoom']);
  socket.onmessage!(answer(socket.requests()[0].id, workspaces));
  await expect(read).resolves.toEqual(workspaces);
  expect(connection.commandState().ready).toBe(true);
  void room.catch(() => undefined);
});

it('closes a launch socket opened with another token and sends the read itself', async () => {
  const { socket, release } = launch({
    token: 'expired-access',
    received: [answer('launch-1', workspaces)],
  });
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
  replacement.emit({
    t: 'res',
    id: replacement.requests()[0].id,
    ok: true,
    result: { workspaces: [] },
  });
  await expect(read).resolves.toEqual({ workspaces: [] });
});

it('discards an unclaimed launch answer when the socket drops', async () => {
  const { socket } = launch({ received: [answer('launch-1', workspaces)] });
  const connection = connect();
  void connection.request('getAuthCapabilities', {}).catch(() => undefined);
  await tick();
  socket.drop();
  let answered = false;
  const read = connection.request('readWorkspaces', {}).then((value) => {
    answered = true;
    return value;
  });
  await tick();
  const replacement = Socket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  replacement.open();
  await tick();
  expect(answered).toBe(false);
  const own = replacement.requests().filter((frame) => frame.op === 'readWorkspaces');
  for (const frame of own)
    replacement.emit({ t: 'res', id: frame.id, ok: true, result: { workspaces: [] } });
  await expect(read).resolves.toEqual({ workspaces: [] });
});

it('leaves native connections alone', async () => {
  state.platform = 'android';
  const { socket, page } = launch({ received: [answer('launch-1', workspaces)] });
  void connect()
    .request('readWorkspaces', {})
    .catch(() => undefined);
  await tick();
  expect(Socket.instances.at(-1)).not.toBe(socket);
  expect((page as { __beelineLaunchLive?: unknown }).__beelineLaunchLive).toBeDefined();
});

const roomId = 'launch-room';
const staleRoom = { room: { id: roomId }, messages: [] };
const freshRoom = { room: { id: roomId }, messages: [{ id: 'committed-message' }] };
const delta = { type: 'message-delta', roomId, message: { id: 'committed-message' } };
const event = (frame: unknown) => ({ data: JSON.stringify(frame) });
async function adopt(connection: LiveConnection, socket: Socket) {
  const read = connection.request('getAuthCapabilities', {});
  await tick();
  const frame = socket.requests().find((frame) => frame.op === 'getAuthCapabilities')!;
  socket.emit({ t: 'res', id: frame.id, ok: true, result: {} });
  await read;
}

it.each(['buffered', 'adopted'])('discards a stale Room launch reply after a %s committed frame before claim', async (timing) => {
  const { socket } = launch({
    roomId,
    received: [answer('launch-1', staleRoom), ...(timing === 'buffered' ? [event(delta)] : [])],
  });
  const connection = connect();
  await adopt(connection, socket);
  if (timing === 'adopted') socket.emit(delta);
  const read = connection.request('readRoom', { roomId });
  await tick();
  const frame = socket.requests().find((frame) => frame.op === 'readRoom');
  expect(frame).toMatchObject({ op: 'readRoom', args: { roomId } });
  expect(frame.id).not.toBe('launch-1');
  socket.onmessage!(answer('launch-1', staleRoom));
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshRoom });
  await expect(read).resolves.toEqual(freshRoom);
  expect(Socket.instances).toEqual([socket]);
});

it.each(['presence', 'draft', 'subscribed', 'thought', 'retract'])('preserves the launch reply across %s frames', async (type) => {
  const { socket } = launch({ roomId, received: [answer('launch-1', staleRoom), event({ type, roomId })] });
  const connection = connect();
  await adopt(connection, socket);
  socket.emit({ type, roomId });
  await expect(connection.request('readRoom', { roomId })).resolves.toEqual(staleRoom);
  expect(socket.requests().filter((frame) => frame.op === 'readRoom')).toEqual([]);
});

it('sends an ordinary Room read when a committed frame interrupts a claimed launch read', async () => {
  const { socket } = launch({ roomId });
  const read = connect().request('readRoom', { roomId });
  await tick();
  expect(socket.requests()).toEqual([]);
  socket.emit(delta);
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: 'readRoom', args: { roomId } });
  expect(frame.id).not.toBe('launch-1');
  socket.onmessage!(answer('launch-1', staleRoom));
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshRoom });
  await expect(read).resolves.toEqual(freshRoom);
});

it.each(['buffered', 'adopted'])('refreshes a later Room registration once after a %s committed frame follows the launch answer', async (timing) => {
  const { socket } = launch({ roomId, received: [answer('launch-1', staleRoom), ...(timing === 'buffered' ? [event(delta)] : [])] });
  const connection = connect();
  await expect(connection.request('readRoom', { roomId })).resolves.toEqual(staleRoom);
  if (timing === 'adopted') {
    socket.emit(delta);
    socket.emit(delta);
  }
  const unrelated = vi.fn();
  await connection.register([{ '#h': ['another-room'] }], unrelated);
  expect(unrelated).not.toHaveBeenCalled();
  const listener = vi.fn();
  await connection.register([{ '#h': [roomId] }], listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId, reason: 'resync' } });
  const later = vi.fn();
  await connection.register([{ '#d': ['room:' + roomId] }], later);
  expect(later).not.toHaveBeenCalled();
});

it('uses normal live delivery when the Room is already registered', async () => {
  const { socket } = launch({ roomId, received: [answer('launch-1', staleRoom)] });
  const connection = connect();
  await expect(connection.request('readRoom', { roomId })).resolves.toEqual(staleRoom);
  const listener = vi.fn();
  await connection.register([{ '#h': [roomId] }], listener);
  socket.emit(delta);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: delta });
  const later = vi.fn();
  await connection.register([{ '#h': [roomId] }], later);
  expect(later).not.toHaveBeenCalled();
});

it('ignores committed frames for other Rooms', async () => {
  const { socket } = launch({ roomId, received: [answer('launch-1', staleRoom)] });
  const connection = connect();
  await adopt(connection, socket);
  socket.emit({ ...delta, roomId: 'another-room' });
  await expect(connection.request('readRoom', { roomId })).resolves.toEqual(staleRoom);
});

it.each([undefined, roomId])('voids every launch read on missed updates (Room %s)', async (roomId) => {
  const { socket } = launch({ roomId });
  const connection = connect();
  const read = roomId ? connection.request('readRoom', { roomId }) : connection.request('readWorkspaces', {});
  await tick();
  socket.emit({ type: 'missed-updates', roomIds: [], streams: [], workspace: false });
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: roomId ? 'readRoom' : 'readWorkspaces' });
  const fresh = roomId ? freshRoom : workspaces;
  socket.onmessage!(answer('launch-1', {}));
  socket.emit({ t: 'res', id: frame.id, ok: true, result: fresh });
  await expect(read).resolves.toEqual(fresh);
});

it('sends its own Room read when adoption precedes the launch acknowledgement', async () => {
  const { socket, release } = launch({ roomId, unsent: true });
  const read = connect().request('readRoom', { roomId });
  await tick();
  expect(release).toHaveBeenCalledOnce();
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: 'readRoom', args: { roomId } });
  expect(frame.id).not.toBe('launch-1');
  socket.emit({ type: 'subscribed', roomId });
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshRoom });
  await expect(read).resolves.toEqual(freshRoom);
  expect(socket.requests()).toHaveLength(1);
  expect(Socket.instances).toEqual([socket]);
});

it('takes reads sent after construction from the released launch handoff', async () => {
  const { socket, page, release } = launch({ roomId, unsent: true, received: [answer('launch-1', staleRoom)] });
  const connection = connect();
  const handoff = page.__beelineLaunchLive as { reads: unknown[] };
  handoff.reads.push({ id: 'launch-1', op: 'readRoom', args: { roomId } });
  const read = connection.request('readRoom', { roomId });
  await tick();
  await expect(read).resolves.toEqual(staleRoom);
  expect(release).toHaveBeenCalledOnce();
  expect(socket.requests()).toEqual([]);
});

it('uses the final read list left by release rather than the construction-time list', async () => {
  const { socket, page, release } = launch({ roomId });
  const connection = connect();
  release.mockImplementation(() => {
    (page.__beelineLaunchLive as { reads: unknown[] }).reads = [];
    return [];
  });
  const read = connection.request('readRoom', { roomId });
  await tick();
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: 'readRoom', args: { roomId } });
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshRoom });
  await expect(read).resolves.toEqual(freshRoom);
});

const membershipChanged = { type: 'invalidate', roomId: '', reason: 'postgres:memberships' };
const freshWorkspaces = { workspaces: [{ id: 'launch-workspace' }, { id: 'joined-workspace' }] };

it.each(['buffered', 'adopted'])('voids a Workspace launch answer after a %s membership change before claim', async (timing) => {
  const { socket } = launch({ received: [answer('launch-1', workspaces), ...(timing === 'buffered' ? [event(membershipChanged)] : [])] });
  const connection = connect();
  await adopt(connection, socket);
  if (timing === 'adopted') socket.emit(membershipChanged);
  const read = connection.request('readWorkspaces', {});
  await tick();
  const frame = socket.requests().find((frame) => frame.op === 'readWorkspaces')!;
  expect(frame).toMatchObject({ op: 'readWorkspaces', args: {} });
  expect(frame.id).not.toBe('launch-1');
  socket.onmessage!(answer('launch-1', workspaces));
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshWorkspaces });
  await expect(read).resolves.toEqual(freshWorkspaces);
  expect(Socket.instances).toEqual([socket]);
});

it.each([
  { type: 'invalidate', roomId: '', reason: 'postgres:room_read_marks' },
  { type: 'invalidate', roomId: 'another-room', reason: 'postgres:memberships' },
  { type: 'presence', roomId: 'another-room', agentId: 'agent', status: 'online', observedAt: 1 },
])('retains the Workspace launch answer across unrelated frames: %j', async (frame) => {
  const { socket } = launch({ received: [answer('launch-1', workspaces), event(frame)] });
  const connection = connect();
  await adopt(connection, socket);
  socket.emit(frame);
  await expect(connection.request('readWorkspaces', {})).resolves.toEqual(workspaces);
  expect(socket.requests().filter((frame) => frame.op === 'readWorkspaces')).toEqual([]);
});

it('replaces an in-flight Workspace launch read when membership changes', async () => {
  const { socket } = launch();
  const read = connect().request('readWorkspaces', {});
  await tick();
  expect(socket.requests()).toEqual([]);
  socket.emit(membershipChanged);
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: 'readWorkspaces', args: {} });
  expect(frame.id).not.toBe('launch-1');
  socket.onmessage!(answer('launch-1', workspaces));
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshWorkspaces });
  await expect(read).resolves.toEqual(freshWorkspaces);
});

it.each(['buffered', 'adopted'])('refreshes a Workspace consumer after a %s change follows a served launch answer', async (timing) => {
  const { socket } = launch({ received: [answer('launch-1', workspaces), ...(timing === 'buffered' ? [event(membershipChanged)] : [])] });
  const connection = connect();
  await expect(connection.request('readWorkspaces', {})).resolves.toEqual(workspaces);
  if (timing === 'adopted') socket.emit(membershipChanged);
  await connection.register([], () => {});
  const roomListener = vi.fn();
  await connection.register([{ '#h': ['room'] }], roomListener);
  expect(roomListener).not.toHaveBeenCalled();
  const listener = vi.fn();
  await connection.register([], listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
  const fresh = connection.request('readWorkspaces', {});
  await tick();
  const [frame] = socket.requests();
  expect(frame).toMatchObject({ op: 'readWorkspaces', args: {} });
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshWorkspaces });
  await expect(fresh).resolves.toEqual(freshWorkspaces);
  const later = vi.fn();
  await connection.register([], later);
  expect(later).not.toHaveBeenCalled();
});

it('delivers Workspace changes to a listening consumer through the normal refresh path', async () => {
  const { socket } = launch({ received: [answer('launch-1', workspaces)] });
  const connection = connect();
  await expect(connection.request('readWorkspaces', {})).resolves.toEqual(workspaces);
  let fresh: Promise<unknown> | undefined;
  const listener = vi.fn(() => { fresh = connection.request('readWorkspaces', {}); });
  await connection.register([], listener);
  socket.emit(membershipChanged);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ monolithLive: membershipChanged });
  await tick();
  const [frame] = socket.requests();
  socket.emit({ t: 'res', id: frame.id, ok: true, result: freshWorkspaces });
  await expect(fresh).resolves.toEqual(freshWorkspaces);
  const later = vi.fn();
  await connection.register([], later);
  expect(later).not.toHaveBeenCalled();
});
