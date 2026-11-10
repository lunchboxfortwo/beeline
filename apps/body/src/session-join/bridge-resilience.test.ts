import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer as httpServer, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForProcessExit } from '../process-exit.js';
import { ensureBridge, refreshJoinedSessionBridge } from './bridge.js';
import { readState, updateState } from './store.js';
import { recoveryCliBundleArgs } from '../../../../scripts/recovery-cli-bundle.mjs';

const artifacts = mkdtempSync(join(tmpdir(), 'bridge-resilience-build-'));
const good = join(artifacts, 'good.mjs'), broken = join(artifacts, 'broken.mjs');
beforeAll(() => {
  const args = recoveryCliBundleArgs(resolve('src/recovery-cli.ts'), good);
  execFileSync('npx', args, { stdio: 'pipe' });
  execFileSync('npx', recoveryCliBundleArgs(resolve('src/recovery-cli.ts'), broken)
    .filter((arg: string) => !arg.startsWith('--banner:')), { stdio: 'pipe' });
}, 30_000);
afterAll(() => rmSync(artifacts, { recursive: true, force: true }));

const cases = [
  { dead: false, bad: false, hook: false }, { dead: false, bad: true, hook: false },
  { dead: true, bad: false, hook: false }, { dead: true, bad: true, hook: false },
  { dead: false, bad: false, hook: true },
];
for (const { dead, bad, hook } of cases) {
  it(`${dead ? 'dead' : 'serving'} bridge survives a ${bad ? 'node:assert-broken' : 'good'} ${hook ? 'SessionStart entry' : 'release'} with exactly-once wake delivery`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-resilience-'));
    const dir = join(home, 'beeline-sessions'); mkdirSync(dir);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude') };
    const events = new EventEmitter();
    const streams: ServerResponse[] = [];
    const frames: object[] = [];
    const messages: string[] = [];
    let holdCandidate = false;
    let upgrading = false, lostStreamCoverage = false;
    const http = httpServer((request, response) => {
      if (request.method === 'POST') {
        request.resume(); response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { capabilities: { memberStreamV1: true } } })); return;
      }
      streams.push(response);
      response.once('close', () => {
        if (upgrading && !dead && !streams.some(stream => !stream.destroyed && stream.headersSent)) lostStreamCoverage = true;
      });
      response.setHeader('content-type', 'application/x-ndjson');
      if (!holdCandidate) {
        response.flushHeaders();
        for (const frame of frames) response.write(JSON.stringify(frame) + '\n');
      }
      events.emit('stream');
    });
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address() as { port: number };
    const socket = join(home, 'claude.sock');
    const receiver = createServer(peer => {
      let text = ''; peer.on('data', chunk => { text += chunk; });
      peer.on('end', () => { messages.push(JSON.parse(text).message.content); events.emit('delivery'); });
    });
    receiver.listen(socket); await once(receiver, 'listening');
    const key = `claude-code:${home}`;
    await updateState(dir, state => { state.sessions = [{ key, agent: 'claude-code', cwd: home, name: 'Claude',
      server: `http://127.0.0.1:${address.port}`, clientId: 'synthetic', refreshToken: 'synthetic',
      accessToken: 'synthetic', accessExpiresAt: Date.now() + 3_600_000, cursor: '0', deliveredWakes: [],
      sessionId: 'resilience', pid: process.pid, joinedAt: '' }]; });
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'sessions'), { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: 'resilience', cwd: home, messagingSocketPath: socket,
    }));
    const pid = () => Number(readFileSync(join(dir, 'bridge.pid'), 'utf8'));
    const deliver = (id: number) => {
      const frame = { v: 1, type: 'delivery', deliveryId: `wake:${id}`, mentions: [], mentionCursor: '0',
        wakes: [{ id: `wake-${id}`, address: 'synthetic-room', reason: 'supervision', text: `proof-wake-${id}`, createdAt: new Date().toISOString() }] };
      frames.push(frame);
      for (const stream of streams) if (!stream.destroyed && stream.headersSent) stream.write(JSON.stringify(frame) + '\n');
    };
    const received = async (id: number) => {
      while (!messages.some(message => message.includes(`proof-wake-${id}`))) await once(events, 'delivery');
    };
    let hookProcess: ChildProcess | undefined;
    try {
      await refreshJoinedSessionBridge(good, env);
      await ensureBridge(dir, { node: process.execPath, bundle: join(dir, 'usebeeline.mjs') }, env);
      const old = pid();
      const retained = readFileSync(join(dir, 'usebeeline.mjs'));
      deliver(1); await received(1);
      if (dead) { process.kill(old); await waitForProcessExit(old); }
      const next = join(home, 'release.mjs');
      writeFileSync(next, bad ? readFileSync(broken) : Buffer.concat([retained, Buffer.from('\n// new release\n')]));
      holdCandidate = !bad;
      const connected = once(events, 'stream');
      upgrading = true;
      let refresh: Promise<void>;
      if (hook) {
        hookProcess = spawn(process.execPath, [next, 'session', 'hook', 'claude-code', 'session-start'], {
          env, stdio: ['pipe', 'ignore', 'inherit'],
        });
        hookProcess.stdin!.end('{}');
        refresh = once(hookProcess, 'exit').then(([code]) => { expect(code).toBe(0); });
      } else refresh = refreshJoinedSessionBridge(next, env);
      // Observe failure immediately so the deliberate rejection cannot escape.
      const result = refresh.then(() => undefined, error => error as Error);
      if (!bad) {
        await connected;
        expect(readFileSync(join(dir, 'usebeeline.mjs')).equals(retained)).toBe(true);
        if (!dead) expect(pid()).toBe(old);
        // While candidate startup is held, the old bridge still serves. When
        // dead, this wake is retained by the server and caught up on activation.
        deliver(2);
        if (!dead) { await received(2); expect(pid()).toBe(old); }
        const candidate = streams.at(-1)!;
        candidate.flushHeaders();
        // Replay duplicates deliberately: both connections saw this boundary.
        for (const frame of frames) candidate.write(JSON.stringify(frame) + '\n');
      }
      const failure = await result;
      if (bad) {
        expect(failure?.message).toMatch(/exited before read/);
        const log = readFileSync(join(dir, 'bridge.log'), 'utf8');
        expect(log).toContain('Dynamic require of "node:assert" is not supported');
        expect(readFileSync(join(dir, 'usebeeline.mjs')).equals(retained)).toBe(true);
        if (!dead) expect(pid()).toBe(old);
        expect(log).toContain('bridge upgrade failed:');
      } else {
        expect(failure).toBeUndefined(); expect(pid()).not.toBe(old);
        await received(2);
        expect(readFileSync(join(dir, 'usebeeline.mjs')).equals(readFileSync(next))).toBe(true);
      }
      deliver(3); await received(3);
      upgrading = false;
      expect(lostStreamCoverage).toBe(false);
      expect(readState(dir).sessions[0]?.deliveredWakes).toEqual(bad ? ['wake-1', 'wake-3'] : ['wake-1', 'wake-2', 'wake-3']);
      for (const id of bad ? [1, 3] : [1, 2, 3]) expect(messages.filter(message => message.includes(`proof-wake-${id}`))).toHaveLength(1);
      console.log(`PROOF ${dead ? 'dead' : 'serving'} + ${bad ? 'broken' : hook ? 'SessionStart' : 'good'}: wakes delivered exactly once; ${bad ? 'retained bundle preserved; failure logged' : 'new bundle owns bridge; handoff wake delivered'}`);
    } finally {
      upgrading = false;
      if (hookProcess && hookProcess.exitCode === null && hookProcess.signalCode === null) {
        const ended = once(hookProcess, 'exit'); hookProcess.kill(); await ended;
      }
      try { const current = pid(); process.kill(current); await waitForProcessExit(current); } catch { /* already exited */ }
      for (const stream of streams) stream.destroy();
      http.closeAllConnections();
      await new Promise<void>(done => http.close(() => done()));
      await new Promise<void>(done => receiver.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
}
