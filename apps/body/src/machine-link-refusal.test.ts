import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it } from 'vitest';
import { MachineLink } from './machine-link.js';

const agentId = 'cd'.repeat(32);
class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (message: { data: string }) => void;
  frames: Record<string, any>[] = [];
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ agentId, ...frame }) });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  terminate() {
    this.close();
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const sockets: Socket[] = [];
  const refused: string[] = [];
  const machine = new MachineLink({
    baseUrl: 'http://synthetic.invalid',
    factory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const channel = machine.attach(agentId, {
    registration: () => ({ token: 'bdt_test' }),
    onOpen: () => {},
    onClose: () => {},
    onMessage: () => {},
    onRefused: (code) => refused.push(code),
    onUpdateRequired: () => {},
  });
  channel.start();
  cleanups.push(() => machine.stop());
  return { machine, channel, sockets, refused };
}
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: Error & { code?: string }) => ({ error: error.message, code: error.code }),
  );
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// Repro F: before, a refusal left operationReady and the queued operation pending forever.
it('a refused registration ends waiting and unsent work with the refusal code', async () => {
  const { channel, sockets, refused } = fixture();
  const ready = settled(channel.operationReady());
  const operation = settled(
    channel.requestOperation('getAgentConfiguration', { agentId } as never),
  );
  sockets[0]!.open();
  sockets[0]!.receive({ type: 'register-refused', code: 'token_revoked_pending' });
  expect(refused).toEqual(['token_revoked_pending']);
  expect(await ready).toEqual({
    error: 'Agent registration refused: token_revoked_pending',
    code: 'token_revoked_pending',
  });
  expect(await operation).toEqual({
    error: 'Agent registration refused: token_revoked_pending',
    code: 'token_revoked_pending',
  });
  // Later work on the same refused socket is refused at once, and nothing was sent.
  expect(await settled(channel.operationReady())).toMatchObject({ code: 'token_revoked_pending' });
  expect(
    await settled(channel.requestOperation('getAgentConfiguration', { agentId } as never)),
  ).toMatchObject({
    code: 'token_revoked_pending',
  });
  expect(sockets[0]!.frames.some((frame) => frame.type === 'daemon-operation')).toBe(false);
  expect(sockets).toHaveLength(1);
});

it('a sent operation ends on close before a successor registration is refused', async () => {
  const { channel, sockets } = fixture();
  const operation = settled(
    channel.requestOperation('postRoomMessage', {
      roomId: 'room',
      requestId: 'r',
      text: 'x',
    } as never),
  );
  sockets[0]!.open();
  sockets[0]!.receive({ type: 'registered', capabilities: {} });
  expect(sockets[0]!.frames.some((frame) => frame.type === 'daemon-operation')).toBe(true);
  sockets[0]!.close();
  await flush();
  sockets[1]!.open();
  sockets[1]!.receive({ type: 'register-refused', code: 'registration_failed' });
  expect(await operation).toEqual({
    error: 'Agent connection closed; outcome unknown',
    code: 'connection_closed',
  });
});

it('an unregistered agent ends sent work as outcome unknown and refuses waiting work', async () => {
  const { channel, sockets } = fixture();
  sockets[0]!.open();
  sockets[0]!.receive({ type: 'registered', capabilities: {} });
  const sent = settled(
    channel.requestOperation('postRoomMessage', {
      roomId: 'room',
      requestId: 'r',
      text: 'x',
    } as never),
  );
  sockets[0]!.receive({ type: 'unregistered', reason: 'replaced', code: 4001 });
  const waiting = settled(channel.operationReady());
  expect(await sent).toEqual({
    error: 'Agent registration ended: replaced; outcome unknown',
    code: 'unregistered',
  });
  expect(await waiting).toEqual({
    error: 'Agent registration ended: replaced',
    code: 'unregistered',
  });
});

it('the next socket registers again and serves work after a refusal', async () => {
  const { channel, sockets } = fixture();
  sockets[0]!.open();
  sockets[0]!.receive({ type: 'register-refused', code: 'registration_failed' });
  sockets[0]!.close();
  await flush();
  sockets[1]!.open();
  expect(sockets[1]!.frames).toContainEqual(expect.objectContaining({ type: 'register-machine' }));
  const ready = channel.operationReady();
  sockets[1]!.receive({ type: 'registered', capabilities: {} });
  await ready;
  const operation = channel.requestOperation('getAgentConfiguration', { agentId } as never);
  const frame = sockets[1]!.frames.find((item) => item.type === 'daemon-operation')!;
  sockets[1]!.receive({
    type: 'daemon-operation-result',
    requestId: frame.requestId,
    result: { id: 'ok' },
  });
  await expect(operation).resolves.toEqual({ id: 'ok' });
});
