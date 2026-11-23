import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bridgeSocketPath } from './bridge-socket.js';
import { updateState, type JoinedSession } from './store.js';

const children: ChildProcess[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** What answers on a socket path: the first bytes its listener writes, or the connect error. */
function greeting(path: string): Promise<string> {
  return new Promise((done) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    socket.once('data', (text: string) => {
      socket.destroy();
      done(text);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
  });
}

// Astra P1 #8: a staged candidate renamed its socket over the serving bridge's
// public socket before it claimed ownership, then lost the claim and exited.
it('a staged candidate that loses the ownership claim leaves the serving public socket in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-order-'));
  folders.push(dir);
  const stateDir = join(dir, 'beeline-sessions');
  mkdirSync(stateDir, { recursive: true });
  const joined = {
    key: `claude-code:${dir}`,
    agent: 'claude-code',
    cwd: dir,
    name: 'Claude',
    server: 'https://synthetic.invalid',
    clientId: 'client',
    refreshToken: 'synthetic',
    accessToken: 'synthetic',
    accessExpiresAt: Date.now() + 3_600_000,
    cursor: '1',
    deliveredWakes: [],
    joinedAt: '',
    deliveryGeneration: 'order',
    deliveryMechanism: 'local',
  } as JoinedSession;
  await updateState(stateDir, (state) => {
    state.sessions = [joined];
  });
  // The serving bridge: a live process named by bridge.pid, and a public socket.
  const serving = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(serving);
  writeFileSync(join(stateDir, 'bridge.pid'), String(serving.pid));
  const publicSocket = bridgeSocketPath(stateDir);
  const server = createServer((peer) => peer.end('serving bridge'));
  server.listen(publicSocket);
  await once(server, 'listening');
  try {
    const candidate = join(dir, 'candidate.mjs');
    writeFileSync(
      candidate,
      `import { tsImport } from ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))};
    const { runBridge } = await tsImport(${JSON.stringify(resolve('src/session-join/bridge.ts'))}, import.meta.url);
    // Member streams never open: the candidate waits for its handoff.
    globalThis.fetch = () => new Promise(() => {});
    await runBridge(${JSON.stringify(stateDir)}, { node: process.execPath, bundle: ${JSON.stringify(candidate)} });`,
    );
    const child = fork(candidate, [], {
      env: { ...process.env, HOME: dir, XDG_STATE_HOME: dir, BEELINE_SESSION_BRIDGE_STAGING: '1' },
      stdio: 'ignore',
    });
    children.push(child);
    const staged = bridgeSocketPath(stateDir, child.pid);
    // Its staged socket appears once it listens, after it subscribed to `activate`.
    await new Promise<void>((done) => {
      const watcher = watch(dirname(staged), () => {
        if (!existsSync(staged)) return;
        watcher.close();
        done();
      });
      if (existsSync(staged)) {
        watcher.close();
        done();
      }
    });
    child.send('activate');
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(await greeting(publicSocket)).toBe('serving bridge');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 20_000);
