import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { recordHookSession, updateState, type JoinedSession } from './store.js';
import { ensureBridge, notifyBridgeSessions } from './bridge.js';
import { bridgeSocketPath } from './bridge-socket.js';

const children: ChildProcess[] = [];
const folders: string[] = [];
const watchers = new Set<ReturnType<typeof watch>>();
afterEach(async () => {
  for (const watcher of watchers) watcher.close();
  watchers.clear();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function received(path: string, text: string): Promise<void> {
  return new Promise(resolve => {
    const check = () => existsSync(path) && readFileSync(path, 'utf8').includes(text);
    const watcher = watch(join(path, '..'), () => {
      if (check()) { watcher.close(); watchers.delete(watcher); resolve(); }
    });
    watchers.add(watcher);
    if (check()) { watcher.close(); watchers.delete(watcher); resolve(); }
  });
}

it.each(['short', 'long', 'unicode'])('opens successive joins through a %s state path and delivers their tags', async length => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-session-control-'));
  folders.push(home);
  const dir = join(home, length === 'long' ? 'state-'.repeat(30) : length === 'unicode' ? '巢'.repeat(26) : 'state'); mkdirSync(dir);
  const socket = bridgeSocketPath(dir);
  if (dirname(socket) !== dir) folders.push(dirname(socket));
  const output = join(home, 'received');
  const cli = join(home, 'codex');
  writeFileSync(cli, `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(output)}, process.argv.join(' ') + '\\n');
  `, { mode: 0o700 });
  const session = (id: string): JoinedSession => ({
    key: `codex:${join(home, id)}`, agent: 'codex', cwd: join(home, id), name: id,
    server: 'https://synthetic.invalid', clientId: id, refreshToken: 'synthetic',
    accessToken: id, accessExpiresAt: Date.now() + 3_600_000,
    cursor: '0', deliveredWakes: [], joinedAt: '', sessionId: id, agentBin: cli, deliveryGeneration:'bound-control',deliveryMechanism:'local',
    deliveryMechanism: 'local',
  });
  // Seed host records before startup: only the explicit socket notification
  // should open a new member stream, without a later hook rescuing the join.
  for (const id of ['first', 'second', 'third']) {
    recordHookSession(dir, { agent: 'codex', sessionId: id, cwd: join(home, id), seenAt: Date.now() });
  }
  await updateState(dir, state => { state.sessions = [session('first')]; });
  const source = resolve('src/session-join/bridge.ts');
  const bundle = join(home, 'usebeeline.mjs');
  const script = `import { tsImport } from ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))};
    import { appendFileSync } from 'node:fs';
    const { runBridge } = await tsImport(${JSON.stringify(source)}, import.meta.url);
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') return Response.json({ result: { capabilities: { memberStreamV1: true } } });
      const id = init.headers.authorization.slice('Bearer '.length);
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ v: 1, type: 'delivery',
          deliveryId: 'mention:' + id, mentions: [{ id, room_id: 'chat', text: 'tag-' + id }],
          wakes: [], mentionCursor: '1' }) + '\\n'));
        init.signal.addEventListener('abort', () => {
          appendFileSync(${JSON.stringify(output)}, 'closed-' + id + '\\n');
          controller.close();
        }, { once: true });
      } });
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    };
    await runBridge(${JSON.stringify(dir)}, { node: process.execPath, bundle: ${JSON.stringify(bundle)} });`;
  writeFileSync(bundle, script);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const child = spawn(process.execPath, [bundle, 'session', 'bridge'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr!.on('data', chunk => { errors += chunk; });
  children.push(child);
  await Promise.race([received(output, 'tag-first'), once(child, 'exit').then(() => {
    throw new Error(`bridge exited before delivering the first tag: ${errors}`);
  })]);
  expect(statSync(socket).mode & 0o777).toBe(0o600);
  if (dirname(socket) !== dir) expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
  await updateState(dir, state => { state.sessions.push(session('second')); });
  await ensureBridge(dir, { node: process.execPath, bundle }, env);
  await received(output, 'tag-second');
  await updateState(dir, state => { state.sessions.push(session('third')); });
  await ensureBridge(dir, { node: process.execPath, bundle }, env);
  await received(output, 'tag-third');
  expect(Number(readFileSync(join(dir, 'bridge.pid'), 'utf8'))).toBe(child.pid);
  await updateState(dir, state => { state.sessions = state.sessions.filter(s => s.sessionId !== 'second'); });
  await notifyBridgeSessions(dir);
  await received(output, 'closed-second');
  const text = readFileSync(output, 'utf8');
  for (const id of ['first', 'second', 'third']) expect(text.split('tag-' + id)).toHaveLength(2);
  const ended = once(child, 'exit');
  await updateState(dir, state => { state.sessions = []; });
  await notifyBridgeSessions(dir);
  expect((await ended)[0]).toBe(0);
});

it('returns a staged socket startup failure to its launcher instead of hanging on IPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-bind-failure-')); folders.push(dir);
  const source = resolve('src/session-join/bridge.ts');
  const bundle = join(dir, 'usebeeline.mjs');
  writeFileSync(bundle, `import { tsImport } from ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))};
    import { mkdirSync } from 'node:fs';
    const { runBridge } = await tsImport(${JSON.stringify(source)}, import.meta.url);
    mkdirSync(${JSON.stringify(dir)} + '/bridge-' + process.pid + '.sock');
    try { await runBridge(${JSON.stringify(dir)}, { node: process.execPath, bundle: ${JSON.stringify(bundle)} }); }
    catch { process.exitCode = 1; }`);
  const child = spawn(process.execPath, [bundle, 'session', 'bridge'], {
    env: { ...process.env, BEELINE_SESSION_BRIDGE_STAGING: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.push(child);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const ended = await Promise.race([once(child, 'exit'), new Promise<never>((_done, fail) => {
      deadline = setTimeout(() => fail(new Error('failed candidate retained its launcher IPC')), 1500);
    })]);
    expect(ended[0]).toBe(1);
  } finally { clearTimeout(deadline); }
});
