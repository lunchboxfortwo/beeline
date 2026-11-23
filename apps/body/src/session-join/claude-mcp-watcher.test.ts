import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ watch: vi.fn(), input: vi.fn(), scan: vi.fn() }));
vi.mock('../wait.js', async (original) => ({
  ...(await original<typeof import('../wait.js')>()),
  watchChanges: boundary.watch,
}));
vi.mock('node:readline', () => ({ createInterface: boundary.input }));
vi.mock('./claude.js', async (original) => ({
  ...(await original<typeof import('./claude.js')>()),
  scanClaude: boundary.scan,
}));

import { hasClaudeMcp, runClaudeMcp } from './claude-mcp.js';
import { queueInbox, takeInbox, updateState, type JoinedSession } from './store.js';

const folders: string[] = [];
const inputs: PassThrough[] = [];
afterEach(() => {
  for (const input of inputs.splice(0)) input.destroy();
  vi.resetAllMocks();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function receiver(post = vi.fn(async (_target: unknown, _text: string) => {})) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-watcher-'));
  folders.push(dir);
  const joined: JoinedSession = {
    key: `claude-code:${dir}`,
    agent: 'claude-code',
    cwd: dir,
    name: 'fixture',
    pid: process.ppid,
    sessionId: 's1',
    server: 'https://synthetic.invalid',
    clientId: 'fixture',
    refreshToken: 'fixture',
    cursor: '0',
    deliveredWakes: [],
    joinedAt: '',
  };
  await updateState(dir, (state) => {
    state.sessions = [joined];
  });
  boundary.scan.mockReturnValue([
    { pid: process.ppid, sessionId: 's1', messagingSocketPath: '/synthetic' },
  ]);
  boundary.watch.mockReturnValue(vi.fn());
  const input = new PassThrough({ objectMode: true });
  inputs.push(input);
  let listening!: () => void;
  const ready = new Promise<void>((done) => {
    listening = done;
  });
  boundary.input.mockImplementation(() => {
    listening();
    return input;
  });
  const running = runClaudeMcp(
    dir,
    { CLAUDE_CODE_MESSAGING_TOKEN: 'fixture-token' },
    undefined,
    post,
  );
  await ready;
  expect(hasClaudeMcp(dir, process.ppid)).toBe(true);
  const [, change, options] = boundary.watch.mock.calls[0]!;
  return { dir, joined, post, input, running, change, options };
}

it.each(['deliveries', 'delivery file', 'inbox', 'inbox/session.txt', 'state.json', null])(
  'posts queued mail on a %s invalidation without another state write',
  async (path) => {
    const current = await receiver();
    const state = readFileSync(join(current.dir, 'state.json'), 'utf8');
    const queued = queueInbox(current.dir, current.joined.key, 'You joined Beeline');
    current.change(path === 'delivery file' ? relative(current.dir, queued) : path);
    await setImmediate();
    expect(current.post).toHaveBeenCalledWith(
      { path: '/synthetic', token: 'fixture-token' },
      'You joined Beeline',
    );
    expect(current.post).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(current.dir, 'state.json'), 'utf8')).toBe(state);
    current.input.end();
    await current.running;
  },
);

function pendingPaths(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).filter((path) => path.endsWith('.pending'));
}

it('keeps a failed post owed without reposting on its own queue changes', async () => {
  const post = vi.fn(async (_target: unknown, _text: string) => {
    throw new Error('post refused');
  });
  const current = await receiver(post);
  const original = relative(
    current.dir,
    queueInbox(current.dir, current.joined.key, 'owed announcement'),
  );
  current.change(original);
  await setImmediate();
  const [requeued] = pendingPaths(current.dir);
  expect(requeued).toBeDefined();
  for (const path of [
    requeued,
    requeued,
    `${requeued}.${process.pid}.tmp`,
    original,
    original.replace(/\.pending$/, '.done'),
    original.replace(/\.pending$/, `.done.${process.pid}.tmp`),
  ])
    current.change(path);
  await setImmediate();
  expect(post).toHaveBeenCalledTimes(1);
  expect(takeInbox(current.dir, current.joined.key)).toBe('owed announcement');
  current.input.end();
  await current.running;
});

it.each(['delivery file', 'deliveries', 'delivery directory', null])(
  'delivers the join announcement and requeued backlog on a fresh %s wake',
  async (path) => {
    const post = vi.fn(async (_target: unknown, _text: string) => {});
    post.mockRejectedValueOnce(new Error('post refused'));
    const current = await receiver(post);
    const state = readFileSync(join(current.dir, 'state.json'), 'utf8');
    const first = queueInbox(current.dir, current.joined.key, 'earlier probe');
    current.change(relative(current.dir, first));
    await setImmediate();
    const [requeued] = pendingPaths(current.dir);
    current.change(requeued);
    await setImmediate();
    expect(post).toHaveBeenCalledTimes(1);
    const announcement = relative(
      current.dir,
      queueInbox(current.dir, current.joined.key, 'You joined Beeline'),
    );
    current.change(
      path === 'delivery file'
        ? announcement
        : path === 'delivery directory'
          ? announcement.slice(0, announcement.lastIndexOf('/'))
          : path,
    );
    await setImmediate();
    expect(post.mock.calls.map((call) => call[1])).toEqual([
      'earlier probe',
      'earlier probe\n\nYou joined Beeline',
    ]);
    expect(takeInbox(current.dir, current.joined.key)).toBe('');
    expect(readFileSync(join(current.dir, 'state.json'), 'utf8')).toBe(state);
    current.input.end();
    await current.running;
  },
);

it('drains fresh mail that arrived during a post which then fails', async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_done, reject) => {
    fail = reject;
  });
  const post = vi.fn(async (_target: unknown, _text: string) => {});
  post.mockImplementationOnce(() => pending);
  const current = await receiver(post);
  current.change(relative(current.dir, queueInbox(current.dir, current.joined.key, 'first')));
  current.change(relative(current.dir, queueInbox(current.dir, current.joined.key, 'second')));
  fail(new Error('post refused'));
  await setImmediate();
  expect(post.mock.calls.map((call) => call[1])).toEqual(['first', 'second\n\nfirst']);
  expect(takeInbox(current.dir, current.joined.key)).toBe('');
  current.input.end();
  await current.running;
});

it.each(['state.json', 'inbox', null])(
  'delivers after a refused post on a %s invalidation',
  async (path) => {
    const post = vi.fn(async (_target: unknown, _text: string) => {});
    post.mockRejectedValueOnce(new Error('post refused'));
    const current = await receiver(post);
    queueInbox(current.dir, current.joined.key, 'owed announcement');
    current.change('deliveries');
    await setImmediate();
    current.change(path);
    await setImmediate();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1]).toBe('owed announcement');
    expect(takeInbox(current.dir, current.joined.key)).toBe('');
    current.input.end();
    await current.running;
  },
);

it('coalesces a delivery committed while an earlier post is awaiting its answer', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((done) => {
    finish = done;
  });
  const post = vi.fn(async (_target: unknown, _text: string) => {});
  post.mockImplementationOnce(async () => {
    await pending;
  });
  const current = await receiver(post);
  queueInbox(current.dir, current.joined.key, 'first');
  current.change('deliveries');
  const second = queueInbox(current.dir, current.joined.key, 'second');
  current.change(relative(current.dir, second));
  finish();
  await setImmediate();
  expect(post.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
  current.input.end();
  await current.running;
});

it.each(['watcher failure', 'normal shutdown'])(
  'removes its receiver registration on %s',
  async (ending) => {
    const current = await receiver();
    if (ending === 'watcher failure') current.options.onError(new Error('watch channel failed'));
    else current.input.end();
    await setImmediate();
    expect(hasClaudeMcp(current.dir, process.ppid)).toBe(false);
    current.input.end();
    await current.running;
  },
);
