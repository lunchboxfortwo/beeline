import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  watch: vi.fn(),
  release: vi.fn(async () => {}),
  send: vi.fn(),
  tool: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../wait.js', async (original) => ({
  ...(await original<typeof import('../wait.js')>()),
  watchChanges: boundary.watch,
  tryLock: async () => ({ held: true, release: boundary.release }),
  runOwned: boundary.send,
}));
vi.mock('./beeline-api.js', async (original) => ({
  ...(await original<typeof import('./beeline-api.js')>()),
  accessToken: async () => 'token',
  callTool: boundary.tool,
  memberStream: async function* () {},
}));
vi.mock('./sessions.js', async (original) => ({
  ...(await original<typeof import('./sessions.js')>()),
  machineSources: () => ({
    claude: () => [{ pid: process.pid, sessionId: 's1', messagingSocketPath: '/synthetic' }],
    codex: () => [],
    hooks: () => [],
  }),
}));
vi.mock('./claude.js', async (original) => ({
  ...(await original<typeof import('./claude.js')>()),
  postToClaude: boundary.post,
}));

import { notifyBridgeSessions, runBridge, toolViaBridge } from './bridge.js';
import { runAntigravitySidecar } from './pull-apps.js';
import {
  queueInbox,
  recordHookSession,
  takeInbox,
  updateState,
  type JoinedSession,
} from './store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const folders: string[] = [];
const initialSignals = new Map(
  ['SIGTERM', 'SIGINT'].map((name) => [name, process.listeners(name)]),
);
afterEach(() => {
  for (const [name, listeners] of initialSignals)
    for (const listener of process.listeners(name))
      if (!listeners.includes(listener)) process.removeListener(name, listener);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(agent: JoinedSession['agent']) {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-lifecycle-'));
  folders.push(dir);
  const joined: JoinedSession = {
    key: `${agent}:${dir}`,
    agent,
    cwd: dir,
    name: 'fixture',
    sessionId: 's1',
    pid: process.pid,
    server: 'https://synthetic.invalid',
    clientId: 'fixture',
    refreshToken: 'fixture',
    accessToken: 'token',
    cursor: '0',
    deliveredWakes: [],
    joinedAt: '',
    deliveryGeneration: 'generation',
    deliveryMechanism: 'local',
  };
  await updateState(dir, (state) => {
    state.sessions = [joined];
  });
  return { dir, joined };
}
async function bridge(dir: string) {
  const subscribed = deferred<void>();
  const stopped = deferred<void>();
  boundary.watch.mockImplementation(() => {
    subscribed.resolve();
    return () => stopped.resolve();
  });
  const exit = new Error('bridge exit');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exit;
  });
  const bundle = join(dir, 'fixture.mjs');
  writeFileSync(bundle, '// synthetic bridge bundle identity\n');
  const result = runBridge(dir, { node: process.execPath, bundle }).catch((error) => error);
  await subscribed.promise;
  await notifyBridgeSessions(dir);
  return { result, stopped, exit };
}

it.each(['success', 'failure'])(
  'returns an accepted tool %s before shutdown closes its socket',
  async (outcome) => {
    const { dir, joined } = await fixture('pi');
    const accepted = deferred<void>();
    const finish = deferred<void>();
    boundary.tool.mockImplementation(async () => {
      accepted.resolve();
      await finish.promise;
      if (outcome === 'failure') throw new Error('operation refused');
      return { receipt: 'committed' };
    });
    const running = await bridge(dir);
    const reply = toolViaBridge(dir, joined.key, 'post', {});
    await accepted.promise;
    process.emit('SIGTERM');
    await running.stopped.promise;
    await setImmediate();
    expect(process.exit).not.toHaveBeenCalled();
    finish.resolve();
    expect(await reply).toEqual(
      outcome === 'success'
        ? { ok: true, data: { receipt: 'committed' } }
        : { ok: false, error: 'operation refused' },
    );
    expect(await running.result).toBe(running.exit);
  },
);

it.each([0, 1])(
  'keeps sidecar ownership through an active handoff with exit code %i',
  async (code) => {
    const { dir, joined } = await fixture('antigravity');
    recordHookSession(dir, { agent: 'antigravity', sessionId: 's1', cwd: dir, seenAt: Date.now() });
    queueInbox(dir, joined.key, 'owed message');
    boundary.release.mockClear();
    const accepted = deferred<void>();
    const finish = deferred<void>();
    boundary.send.mockImplementation(async () => {
      accepted.resolve();
      await finish.promise;
      return { code, stderr: '', stdout: '' };
    });
    boundary.watch.mockReturnValue(() => {});
    const failure = new Error('watch channel failed');
    const result = runAntigravitySidecar(dir).catch((error) => error);
    await accepted.promise;
    const [, _change, options] = boundary.watch.mock.calls[0]!;
    options.onError(failure);
    _change('deliveries/new.pending');
    await setImmediate();
    expect(boundary.release).not.toHaveBeenCalled();
    expect(boundary.send).toHaveBeenCalledTimes(1);
    finish.resolve();
    expect(await result).toBe(failure);
    expect(boundary.release).toHaveBeenCalledTimes(1);
    expect(takeInbox(dir, joined.key)).toBe(code === 0 ? '' : 'owed message');
  },
);

it.each(['claude-mcp', 'claude-mcp/receiver.json'])(
  'hands pending mail back on removal of %s',
  async (path) => {
    const { dir, joined } = await fixture('claude-code');
    mkdirSync(join(dir, 'claude-mcp'));
    const registration = join(dir, 'claude-mcp', 'receiver.json');
    writeFileSync(registration, JSON.stringify({ pid: process.pid, claudePid: process.pid }));
    queueInbox(dir, joined.key, 'handback message');
    const posted = deferred<void>();
    boundary.post.mockImplementation(async () => {
      posted.resolve();
    });
    const running = await bridge(dir);
    expect(boundary.post).not.toHaveBeenCalled();
    rmSync(registration);
    boundary.watch.mock.calls[0]![1](path);
    await posted.promise;
    expect(boundary.post.mock.calls[0]![1]).toBe('handback message');
    process.emit('SIGTERM');
    expect(await running.result).toBe(running.exit);
  },
);
