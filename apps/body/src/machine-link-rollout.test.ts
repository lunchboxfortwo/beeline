import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { createBeelineServer } from '../../server/src/server.js';
import { migratedDatabase } from '../../server/src/test-support.js';
import type { DaemonService } from '../../server/src/daemon-service.js';
import type { TokenAuth } from '../../server/src/auth.js';
import type { PhoneService } from '../../server/src/phone-service.js';
import { LiveHub } from '../../server/src/live.js';
import { MachineLink } from './machine-link.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

it.each(['restart', 'rollout drain'] as const)('claims queued work after server %s, reading each Room snapshot once', async failure => {
  const database = await migratedDatabase();
  const root = await mkdtemp(join(process.cwd(), '.rollout-test-'));
  const agentId = 'ab'.repeat(32), roomId = 'room';
  const command: AgentCommand = {
    id: 'queued-command', roomId, agentId, sourceMessageId: 'message', turnRequestId: 'request',
    action: 'input', reason: 'human_tag', rootCommandId: 'queued-command',
    rootSourceMessageId: 'message', agentDepth: 0,
    source: { id: 'message', authorId: 'human', body: 'work queued during deploy', createdAt: 1, attachments: [] },
  };
  let pending: AgentCommand[] = [];
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [...pending] };
    if (name === 'getRoomInbox') return { items: [] };
    if (name === 'claimAgentTurn') {
      const commands = pending; pending = [];
      return { commands };
    }
    if (name === 'releaseAgentTurn') return { commands: [] };
    return { id: 'ok', createdAt: 1 };
  });
  const makeBackend = () => createBeelineServer({ database,
    daemon: { execute } as unknown as DaemonService,
    auth: { authenticateDaemon: async () => agentId, retiredDaemonAgent: async () => null } as unknown as TokenAuth,
    phone: { canReadRooms: async (ids: string[]) => new Set(ids) } as unknown as PhoneService,
    live: new LiveHub(), mediaMaximumBytes: 1 });
  let backend = makeBackend();
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  // A loopback rollout proxy keeps the public endpoint while its server restarts.
  const gateway = createServer();
  const connections = new Set<Socket>();
  gateway.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  let draining = false, refused = 0;
  gateway.on('upgrade', (request, socket, head) => {
    if (draining) {
      draining = false; refused++;
      if (failure === 'rollout drain') {
        // Headers arrived, then the draining server vanished mid-response.
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}');
      } else socket.destroy();
      return;
    }
    backend.emit('upgrade', request, socket, head);
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const frames: Record<string, any>[][] = [];
  const sockets: WebSocket[] = [];
  const machine = new MachineLink({ baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    factory: (url, protocols, options) => {
      const socket = new WebSocket(url, protocols, options);
      const sent: Record<string, any>[] = []; frames.push(sent); sockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = ((data: any, ...args: any[]) => {
        sent.push(JSON.parse(String(data))); return (send as any)(data, ...args);
      }) as typeof socket.send;
      return socket;
    } });
  const fetcher = vi.fn(async () => { throw new Error('unexpected HTTP fallback'); });
  const api = new DaemonApiClient(machine.origin, 'bdt_test', agentId, fetcher, undefined, undefined, machine);
  const controller = new AbortController();
  const run = vi.fn(async () => {}), subscribed = vi.fn();
  const intake = runServerCommandIntake({ api, roomId, agentId,
    context: new CommandExecutionContext(root), signal: controller.signal,
    run, stop: () => {}, onSubscriptionState: subscribed });
  void intake.catch(() => {});
  try {
    await vi.waitFor(() => expect(subscribed).toHaveBeenLastCalledWith(true));
    expect(run).not.toHaveBeenCalled();
    const previous = backend;
    backend = makeBackend();
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    draining = true;
    pending = [command];
    await new Promise<void>((resolve, reject) => previous.close(error => error ? reject(error) : resolve()));
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 3_000 });
    await vi.waitFor(() => expect(execute.mock.calls.filter(([name]) => name === 'releaseAgentTurn')).toHaveLength(1));
    expect(refused).toBe(1);
    expect(machine.link.reconnects).toBe(2);
    expect(sockets).toHaveLength(3);
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentTurn')).toHaveLength(1);
    // One bootstrap read; one subscribed snapshot per authenticated connection.
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(3);
    for (const index of [0, 2]) {
      expect(frames[index]!.filter(frame => frame.type === 'register-machine')).toHaveLength(1);
      expect(frames[index]!.filter(frame => frame.type === 'subscribe' && frame.roomId === roomId)).toHaveLength(1);
    }
    expect(frames[1]).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    controller.abort(); machine.stop();
    await intake;
    for (const socket of sockets) socket.terminate();
    for (const socket of connections) socket.destroy();
    const closed = once(gateway, 'close'); gateway.close(); await closed;
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
