import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';

type Listener = (event: unknown) => void;
const script = [
  ...readFileSync('public/index.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g),
][1]![1]!;
const access = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    token: 'saved-access',
    expiresAt: Date.now() + 600_000,
    identityId: 'viewer',
    server: 'https://server.fixture',
    ...overrides,
  });

function launch(pathname: string, saved: Record<string, string | null>, denied = false) {
  const sockets: {
    url: string;
    protocols: string[];
    sent: string[];
    listeners: Map<string, Listener[]>;
  }[] = [];
  class WebSocket {
    sent: string[] = [];
    listeners = new Map<string, Listener[]>();
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      sockets.push(this);
    }
    send(frame: string) {
      this.sent.push(frame);
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener(type: string, listener: Listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((each) => each !== listener),
      );
    }
    fire(type: string, event: unknown = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const window = {
    location: { pathname, search: '' },
    localStorage: {
      getItem(key: string) {
        if (denied) throw new Error('Storage denied');
        return saved[key] ?? null;
      },
    },
    __beelineLaunchLive: undefined as
      | undefined
      | { url: string; token: string; path: string; reads: unknown[]; release(): unknown[] },
  };
  runInNewContext(script, { window, WebSocket, JSON, Date, decodeURIComponent });
  return {
    window,
    sockets: sockets as unknown as (WebSocket & { fire(type: string, event?: unknown): void })[],
  };
}
const signedIn = { 'buzzy.monolith.access.v1': access(), 'buzzy.monolith.identity.v1': 'viewer' };

it.each([['/'], ['/beeline/channels'], ['/beeline/community'], ['/beeline/create-workspace/']])(
  'opens the live socket and sends readWorkspaces on %s once it opens',
  (path) => {
    const { window, sockets } = launch(path, signedIn);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://server.fixture/v1/phone/live');
    expect(sockets[0]!.protocols).toEqual(['bearer.saved-access']);
    expect(sockets[0]!.sent).toEqual([]);
    sockets[0]!.fire('open');
    expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toEqual([
      { t: 'req', id: 'launch-1', op: 'readWorkspaces', args: {} },
    ]);
    expect(window.__beelineLaunchLive).toMatchObject({
      url: 'wss://server.fixture/v1/phone/live',
      token: 'saved-access',
      path,
      reads: [{ id: 'launch-1', op: 'readWorkspaces', args: {} }],
    });
  },
);

it('reads the Room named by a chat path', () => {
  const { sockets } = launch('/beeline/chat/room%20one', signedIn);
  sockets[0]!.fire('open');
  expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toEqual([
    { type: 'subscribe', roomIds: ['room one'], sidebarPreviews: false, roomStateProjections: true },
    { t: 'req', id: 'launch-1', op: 'readRoom', args: { roomId: 'room one' } },
  ]);
});

it('only opens the socket on other pages', () => {
  const { window, sockets } = launch('/beeline/tray', signedIn);
  sockets[0]!.fire('open');
  expect(sockets[0]!.sent).toEqual([]);
  expect(window.__beelineLaunchLive?.reads).toEqual([]);
});

it('hands over the frames received before adoption and stops keeping them', () => {
  const { window, sockets } = launch('/', signedIn);
  sockets[0]!.fire('message', { data: 'first' });
  expect(window.__beelineLaunchLive!.release()).toEqual([{ data: 'first' }]);
  sockets[0]!.fire('message', { data: 'later' });
  expect(window.__beelineLaunchLive!.release()).toEqual([{ data: 'first' }]);
});

it.each([
  ['no saved access', { 'buzzy.monolith.identity.v1': 'viewer' }],
  ['access for another identity', { ...signedIn, 'buzzy.monolith.identity.v1': 'someone-else' }],
  [
    'access about to expire',
    { ...signedIn, 'buzzy.monolith.access.v1': access({ expiresAt: Date.now() + 10_000 }) },
  ],
  [
    'access saved before the server was recorded',
    { ...signedIn, 'buzzy.monolith.access.v1': access({ server: undefined }) },
  ],
  ['an unreadable record', { ...signedIn, 'buzzy.monolith.access.v1': '{' }],
])('leaves the app to connect with %s', (_case, saved) => {
  const { window, sockets } = launch('/', saved);
  expect(sockets).toEqual([]);
  expect(window.__beelineLaunchLive).toBeUndefined();
});

it('leaves the app to connect when storage is denied', () => {
  expect(launch('/', signedIn, true).sockets).toEqual([]);
});
