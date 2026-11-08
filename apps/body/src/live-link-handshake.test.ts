import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { MachineLink } from './machine-link.js';

it.each([
  [503, true, false],
  [503, false, false],
  [401, false, false],
  [403, false, false],
  [426, false, false],
  [426, true, true],
  [426, false, true],
] as const)('handles HTTP %i upgrade refusal (truncated=%s, update=%s)', async (status, truncated, update) => {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  const connections = new Set<Socket>();
  let attempts = 0;
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    attempts++;
    if (attempts === 1) {
      // A rollout proxy can close after headers without completing its body.
      const body = update ? JSON.stringify({ error: 'update_required', minVersion: 'v999.0.0' }) : '{}';
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: ${Buffer.byteLength(body) + (truncated ? 100 : 0)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, client => {
      client.on('message', () => client.send(JSON.stringify({ type: 'registered-machine',
        agents: [{ type: 'registered', agentId: 'agent', capabilities: {} }] })));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const machine = new MachineLink({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const opened = vi.fn(), updated = vi.fn();
  const agent = machine.attach('agent', { registration: () => ({ token: 'bdt_test' }),
    onOpen: opened, onClose: () => {}, onMessage: () => {}, onUpdateRequired: updated });
  try {
    agent.start();
    if (update && !truncated) {
      await vi.waitFor(() => expect(updated).toHaveBeenCalledWith('v999.0.0'));
      expect(opened).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
      expect(machine.link.state).toBe('disconnected');
      expect(machine.link.reconnects).toBe(0);
      return;
    }
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
    expect(machine.link.reconnects).toBe(1);
    expect(updated).not.toHaveBeenCalled();
  } finally {
    machine.stop();
    for (const client of webSockets.clients) client.terminate();
    for (const socket of connections) socket.destroy();
    webSockets.close();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});
