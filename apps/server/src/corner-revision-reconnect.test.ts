import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { TokenAuth } from './auth.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { afterEach, describe, expect, it, vi, A, R, approved, brief, commissioned, revise, rootFixture } from './test-support-corner-lifecycle.test-support.js';

type Frame = Record<string, unknown> & { commands?: { id: string; roomId: string }[] };
const servers: ReturnType<typeof createBeelineServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** The implementer's helper connecting: open the machine socket, register, subscribe to its queue. */
async function reconnectImplementer(): Promise<Frame> {
  const server = createBeelineServer({
    database: rootFixture.db,
    auth: {
      authenticateDaemon: vi.fn(async (token: string) => (token === 'bdt_implementer' ? A : null)),
      retiredDaemonAgent: vi.fn(async () => null),
      authenticatePhone: vi.fn(async () => null),
    } as unknown as TokenAuth,
    phone: { canReadRooms: vi.fn(async (ids: readonly string[]) => new Set(ids)) } as unknown as PhoneService,
    daemon: rootFixture.daemon,
    live: new LiveHub(),
    mediaMaximumBytes: 1,
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, [MACHINE_SOCKET_PROTOCOL]);
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as Frame));
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const next = async (match: (frame: Frame) => boolean) => {
    let found: Frame | undefined;
    await vi.waitFor(() => { found = frames.find(match); expect(found).toBeDefined(); }, { timeout: 5_000 });
    return found!;
  };
  socket.send(JSON.stringify({ type: 'register', agentId: A, token: 'bdt_implementer', lifecycleId: 'life-implementer' }));
  expect(await next(frame => frame.agentId === A && (frame.type === 'registered' || frame.type === 'register-refused')))
    .toMatchObject({ type: 'registered' });
  socket.send(JSON.stringify({ type: 'subscribe-queue', agentId: A }));
  return next(frame => frame.type === 'commands' && frame.agentId === A);
}

const pendingRevision = async (cornerId: string) => (await rootFixture.db.query<{ id: string }>(
  `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='corner_brief_revision' AND state='pending'`,
  [cornerId, A])).rows;

describe('REVISION-RECONNECT: a revision written while the implementer is offline reaches it on reconnect', () => {
  it.each(['another agent', 'the implementer from its parent chat'] as const)('revised by %s', async (reviser) => {
    const cornerId = await approved();
    // Offline: no helper connection and no presence for the implementer.
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1`, [A])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A])).rowCount).toBe(0);
    if (reviser === 'another agent') {
      expect(await revise(cornerId)).toMatchObject({ revision: 2, wake: { queued: true, agentId: A } });
    } else {
      const command = await commissioned(R, A);
      expect(await rootFixture.daemon.execute('reviseCornerBrief', { roomId: R, cornerId, requestId: command.turnRequestId,
        expectedRevision: 1, brief: { ...brief(command.sourceMessageId), spec: 'Revised from the Room', change: 'Changed scope' } }, A))
        .toMatchObject({ revision: 2, wake: { queued: true, agentId: A } });
    }
    // The revision is recorded for the implementer and waits in its queue.
    const [queued] = await pendingRevision(cornerId);
    expect(queued).toBeDefined();
    // Reconnect: the helper's first queue frame carries the revision, in the thread.
    const frame = await reconnectImplementer();
    expect(frame.commands).toEqual(expect.arrayContaining([expect.objectContaining({ id: queued!.id, roomId: cornerId })]));
    expect(await pendingRevision(cornerId)).toEqual([queued]);
  });
});
