import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import type { PhoneService } from './phone-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { HelperVersionGate, helperVersionBelowMinimum } from './helper-version-gate.js';

describe('helper minimum version', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('compares release versions numerically and fails closed for missing versions', () => {
    expect(helperVersionBelowMinimum('v0.0.9', 'v0.0.10')).toBe(true);
    expect(helperVersionBelowMinimum('v0.1.0', 'v0.0.10')).toBe(false);
    expect(helperVersionBelowMinimum(undefined, 'v0.0.10')).toBe(true);
    expect(helperVersionBelowMinimum('invalid', 'v0.0.10')).toBe(true);
    const gate = new HelperVersionGate('v0.0.10');
    expect(() => gate.raise('v0.0.9')).toThrow(/cannot decrease/);
  });

  it('keeps old and unversioned helpers connected and serving their queues', async () => {
    const authenticateDaemon = vi.fn().mockResolvedValue('agent');
    const canReadRooms = vi.fn();
    const execute = vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon, authenticatePhone: vi.fn().mockResolvedValue(null) } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      helperVersionGate: new HelperVersionGate('v0.0.10'),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/daemon/operations/getAgentCommands`;
    const post = (version?: string) => fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${'bdt_' + 't'.repeat(24)}`, 'content-type': 'application/json',
        ...(version ? { 'x-beeline-helper-version': version } : {}) },
      body: '{}',
    });
    const old = await post('v0.0.9');
    expect(old.status).toBe(200);
    expect(await old.json()).toEqual({ commandProtocol: 1, commands: [] });
    expect((await post()).status).toBe(200);
    expect(authenticateDaemon).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.9`,
      ['bearer.bdt_test']);
    sockets.push(socket);
    const helloOld = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', raw => resolve(JSON.parse(String(raw)))); socket.once('error', reject);
    });
    expect(await helloOld).toMatchObject({type:'hello'});
    expect(canReadRooms).not.toHaveBeenCalled();

    const current = await post('v0.0.10');
    expect(current.status).toBe(200);
    expect(authenticateDaemon).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenCalledTimes(3);

    const currentSocket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.10&sourceSha=${'a'.repeat(40)}`,
      ['bearer.bdt_test'],
    );
    sockets.push(currentSocket);
    const hello = new Promise<Record<string, unknown>>((resolve) =>
      currentSocket.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>)));
    await expect(hello).resolves.toMatchObject({
      type: 'hello', reportedHelper: { releaseVersion: 'v0.0.10', sourceSha: 'a'.repeat(40) },
    });
    expect(canReadRooms).not.toHaveBeenCalled();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect((await health.json()).live.helperMinimum).toEqual({
      minVersion: 'v0.0.10', refusals: 0, forceUpdates: 0,
    });
  });

  it('reports a minimum release without disconnecting a busy helper', async () => {
    const gate = new HelperVersionGate();
    const authenticateDaemon = vi.fn().mockResolvedValue('agent');
    const canReadRooms = vi.fn();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: { execute: vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] }) } as unknown as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      helperVersionGate: gate,
      releaseNotify: { secret: 'release-secret', subscribeHelperRelease: vi.fn(() => () => {}) } as unknown as ReleaseNotifier,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.9`,
      ['bearer.bdt_test']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
    });
    const update = await fetch(`http://127.0.0.1:${port}/v1/releases/helper-minimum`, {
      method: 'POST', headers: { authorization: 'Bearer release-secret',
        'content-type': 'application/json' },
      body: JSON.stringify({ minVersion: 'v0.0.10' }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ minVersion: 'v0.0.10' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(canReadRooms).not.toHaveBeenCalled();
    expect(gate.minimum).toBe('v0.0.10');
    const version = await fetch(`http://127.0.0.1:${port}/version`);
    expect((await version.json()).minimumHelperVersion).toBe('v0.0.10');
  });
});
