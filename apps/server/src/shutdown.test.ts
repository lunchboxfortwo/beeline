import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { REQUEST_DRAIN_MS, SHUTDOWN_DEADLINE_MS } from './shutdown.js';

async function proveShutdown(mode: 'normal' | 'cleanup' | 'request') {
  const child = fork(new URL('../scripts/shutdown-fixture.mjs', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env,
      BEELINE_SHUTDOWN_STUCK_CLEANUP: mode === 'cleanup' ? '1' : '',
      BEELINE_SHUTDOWN_STUCK_REQUEST: mode === 'request' ? '1' : '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  let socket: WebSocket | undefined;
  try {
    const [ready] = await once(child, 'message') as [{ type: string; port: number }];
    expect(ready.type).toBe('ready');
    const origin = `127.0.0.1:${ready.port}`;
    socket = new WebSocket(`ws://${origin}/v1/phone/live`, ['bearer.bdt_test']);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const started = once(child, 'message');
    const response = fetch(`http://${origin}/auth/slow`).then(r => r.text()).catch(() => 'disconnected');
    expect((await started)[0]).toEqual({ type: 'request-started' });
    const began = Date.now();
    child.kill('SIGTERM');
    // Repeated signals must not bypass the in-flight drain.
    child.kill('SIGINT');
    const body = await response;
    const [code, reason] = await closed as [number, Buffer];
    const [exitCode, signal] = await exited;
    expect(code).toBe(1012);
    expect(reason.toString()).toBe('Server restarting');
    expect(body).toBe(mode === 'request' ? 'disconnected' : 'completed');
    expect(signal).toBeNull();
    expect(exitCode).toBe(mode === 'cleanup' ? 1 : 0);
    expect(Date.now() - began).toBeLessThan(SHUTDOWN_DEADLINE_MS + 2_000);
  } finally {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe('Reproduction DEPLOY-DRAIN-1', () => {
  it('finishes an admitted HTTP request, closes live cleanly and exits on SIGTERM', async () => {
    await proveShutdown('normal');
  });
  it('bounds a cleanup hook that never settles', async () => {
    await proveShutdown('cleanup');
  });
  it('bounds a request that never finishes', async () => {
    await proveShutdown('request');
  });
  it('gives Fly longer than both the request drain and the shutdown deadline', () => {
    const config = readFileSync(new URL('../../infra/fly.beeline-server.toml', import.meta.url), 'utf8');
    const timeout = Number(/^kill_timeout = "(\d+)s"$/m.exec(config)?.[1]) * 1_000;
    expect(config).toMatch(/^kill_signal = "SIGTERM"$/m);
    expect(timeout).toBeGreaterThan(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(REQUEST_DRAIN_MS);
  });
});
