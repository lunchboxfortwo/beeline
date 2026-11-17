import React, { useSyncExternalStore } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { isRoomView, SurfaceResponseCache, type RoomViewAgentTurn } from '@beeline/buzz-client';
import { readRoomView, type RoomLiveDelta } from '@beeline/api-contract/phone';
import { migratedDatabase } from '../../../server/src/test-support';
import { PhoneService } from '../../../server/src/phone-service';
import { DaemonService } from '../../../server/src/daemon-service';
import { LiveHub } from '../../../server/src/live';
import { readAgentCommands } from '../../../server/src/agent-command';
import { startQueuedTurn } from '../../../server/src/test-fixtures/queued-turn.test-support';
import { nextSocketMessage } from '../../../server/src/test-support-server.test-support';
import { createBeelineServer } from '../../../server/src/server';
import { databaseConnectionBudget } from '../../../server/src/database-budget';
import type { TokenAuth } from '../../../server/src/auth';
import { SurfaceRegistry } from './surface-registry';
import { roomSurfaceRecords, offerRoomTurns } from './room-message-records';
import { identityScope } from './identity-records';
import { currentSurfaceStamp } from './surface-clock';
import { observeRoomLiveState } from './room-live-state';
import { isAgentTurnActive } from './agent-presence';
import { publishPhoneLiveEvent } from '@/sync/transport/phone-live-events';
import { resetClientState } from '@/sync/client-reset';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: () => 0,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock('react-native-reanimated', () => ({ useAnimatedStyle: (fn: () => unknown) => fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('../app/(app)/beeline/chat/send-confirmation', () => ({
  useSendConfirmationReceipts: () => undefined,
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: vi.fn(),
  phoneOperationFailureReason: vi.fn(),
}));
import { useChatTurnPresentation } from '../app/(app)/beeline/chat/useChatTurnPresentation';

const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222';
const H = 'a'.repeat(64),
  RUBY = 'b'.repeat(64),
  JELLY = 'c'.repeat(64);

it('settles both chat-specific status lines through receipts, reordered live reads, and reconnect reads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetClientState();
  const db = await migratedDatabase();
  let stop = () => {};
  let tree: ReturnType<typeof create> | undefined;
  let socket: WebSocket | undefined;
  let server: ReturnType<typeof createBeelineServer> | undefined;
  const releases: Array<() => void> = [];
  try {
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),($2,'agent','Ruby','ruby'),($3,'agent','Jellybean','jellybean')`,
      [H, RUBY, JELLY],
    );
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [RUBY, JELLY, H]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')", [W]);
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'beeline')", [R, W]);
    for (const member of [H, RUBY, JELLY])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
        [W, member, R],
      );
    const phone = new PhoneService(db, new LiveHub());
    const sent = await phone.execute(
      'sendRoomMessage',
      { roomId: R, text: '@ruby @jellybean Please answer' },
      H,
    );
    const requests = new Map<string, string>();
    for (const agent of [RUBY, JELLY]) {
      const command = (await readAgentCommands(db, agent, R)).commands.find(
        (c) => c.sourceMessageId === sent.messageId,
      )!;
      await startQueuedTurn(db, R, agent, command.id);
      requests.set(agent, command.turnRequestId);
    }
    await db.query(
      `UPDATE agent_turns SET started_at='2026-11-17T15:10:15Z',created_at='2026-11-17T15:10:15Z' WHERE agent_id=$1`,
      [RUBY],
    );
    await db.query(
      `UPDATE agent_turns SET started_at='2026-11-17T15:10:17Z',created_at='2026-11-17T15:10:17Z' WHERE agent_id=$1`,
      [JELLY],
    );
    const viewer = { relayUrl: 'https://relay.test', viewerPubkey: H };
    const address = { relayOrigin: viewer.relayUrl, viewerPubkey: H, endpoint: `/room/${R}` };
    const scope = identityScope(viewer.relayUrl, H);
    const cache = new SurfaceRegistry(
      new SurfaceResponseCache({
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      }),
      undefined,
      undefined,
      undefined,
      roomSurfaceRecords,
    );
    cache.publish(address, (await phone.readRoom(R, H))!, isRoomView);
    const oldWorking = cache.peek(address, isRoomView)!.latestAgentTurns;
    stop = observeRoomLiveState(cache, () => viewer);
    let entered!: () => void;
    const bothWorkingReads = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const live = new LiveHub();
    server = createBeelineServer({
      database: db,
      live,
      mediaMaximumBytes: 1,
      databaseBudget: databaseConnectionBudget(100, 1, 10),
      auth: { authenticatePhone: async () => H } as unknown as TokenAuth,
      daemon: {} as DaemonService,
      phone: {
        canReadRooms: phone.canReadRooms.bind(phone),
        liveDraftSnapshot: async () => [],
        readLiveDeltas: async (room, viewers, target) => {
          const delta = (await phone.readLiveDeltas(room, [H], target)).get(H);
          if (delta?.type === 'turn-delta' && delta.turn.status === 'working') {
            await new Promise<void>((resolve) => {
              releases.push(resolve);
              if (releases.length === 2) entered();
            });
          }
          return new Map(delta ? viewers.map((viewer) => [viewer, delta]) : []);
        },
      } as PhoneService,
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`,
      ['bearer.phone'],
    );
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    const subscribed = nextSocketMessage(socket, 'subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId: R }));
    await subscribed;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as RoomLiveDelta;
      if (frame.type === 'turn-delta') {
        const turn = readRoomView({
          ...cache.peek(address, isRoomView)!,
          latestAgentTurns: [frame.turn],
        })?.latestAgentTurns[0];
        expect(turn).toBeDefined();
        publishPhoneLiveEvent({ ...frame, turn: turn! });
      } else if (frame.type === 'message-delta') publishPhoneLiveEvent(frame);
    });
    const subscribe = (fn: () => void) => cache.subscribe(address, fn);
    const snapshot = () => cache.peek(address, isRoomView)!;
    const no = () => {};
    function Harness() {
      const view = useSyncExternalStore(subscribe, snapshot);
      const markers = view.latestAgentTurns;
      const args = [
        [],
        null,
        markers,
        no,
        null,
        markers.find(isAgentTurnActive),
        no,
        false,
        view,
        H,
        new Map(view.members.map((member) => [member.identity.pubkey, member.identity])),
        new Map(),
        { bottom: 0 },
        0,
        { isPinnedToTail: () => true, isUserDragging: () => false, follow: no },
        R,
        no,
        false,
        no,
        {},
        no,
        0,
        [],
      ];
      const result = useChatTurnPresentation(
        args as unknown as Parameters<typeof useChatTurnPresentation>[0],
      );
      return React.createElement(
        'status',
        null,
        (result[4] as { label?: string } | null)?.label ?? '',
      );
    }
    act(() => {
      tree = create(React.createElement(Harness));
    });
    const label = () => tree!.root.findByType('status').props.children;
    expect(label()).toMatch(/Jellybean, Ruby brewing/);
    for (const agent of [RUBY, JELLY])
      live.publish({
        type: 'invalidate',
        roomId: R,
        reason: 'postgres:agent_turns',
        agentId: agent,
        requestId: requests.get(agent)!,
      });
    await bothWorkingReads;
    const readStarted = currentSurfaceStamp();
    const daemon = new DaemonService(db, live);
    for (const agent of [JELLY, RUBY]) {
      // The reply precedes the final diagnostic receipt, as on the affected helpers.
      await daemon.execute(
        'postRoomMessage',
        { roomId: R, requestId: requests.get(agent)!, text: 'Finished.' },
        agent,
      );
      const terminal = nextSocketMessage(socket, 'turn-delta');
      await act(async () => {
        await daemon.execute(
          'postAgentTurnReceipt',
          { roomId: R, requestId: requests.get(agent)!, status: 'complete' },
          agent,
        );
        await terminal;
      });
      if (agent === JELLY) {
        expect(
          snapshot()
            .latestAgentTurns.filter(isAgentTurnActive)
            .map((turn) => turn.agentPubkey),
        ).toEqual([RUBY]);
        expect(label()).toMatch(/^Ruby /);
      }
    }
    expect(label()).toBe('');
    // The pong is a socket barrier after the released reads, with no elapsed
    // time advancing or expiring the status line.
    const drained = nextSocketMessage(socket, 'pong');
    await act(async () => {
      releases.forEach((release) => release());
      socket!.send(JSON.stringify({ type: 'ping' }));
      await drained;
    });
    expect(label()).toBe('');
    // A room read started before completion can still return the committed end.
    const ended = (await phone.readRoom(R, H))!;
    expect(ended.latestAgentTurns.every((turn) => !isAgentTurnActive(turn))).toBe(true);
    for (const turn of ended.latestAgentTurns) {
      expect(turn.version).toBeGreaterThan(
        oldWorking.find((old) => old.agentPubkey === turn.agentPubkey)!.version!,
      );
    }
    expect(
      (
        await db.query(
          'SELECT created_at >= ended_at AS recorded_after_end FROM agent_turns WHERE room_id=$1',
          [R],
        )
      ).rows,
    ).toEqual([{ recorded_after_end: true }, { recorded_after_end: true }]);
    act(() => cache.publish(address, ended, isRoomView, readStarted));
    expect(label()).toBe('');
    // A stale response on reconnect must not beat the newer row revision, even
    // if its local request stamp is newer than the terminal live delivery.
    act(() => offerRoomTurns(scope, R, oldWorking, currentSurfaceStamp()));
    expect(label()).toBe('');
    act(() => cache.publish(address, { ...snapshot(), latestAgentTurns: oldWorking }, isRoomView));
    expect(label()).toBe('');
    act(() => publishPhoneLiveEvent({ type: 'turn-delta', roomId: R, turn: oldWorking[0]! }));
    expect(label()).toBe('');
    act(() => cache.publish(address, ended, isRoomView));
    expect(label()).toBe('');
    act(() =>
      publishPhoneLiveEvent({
        type: 'turn-delta',
        roomId: W,
        turn: { ...oldWorking[0]!, version: ended.latestAgentTurns[0]!.version! + 1 },
      }),
    );
    expect(label()).toBe('');
    // Re-delivery of the same unanswered item can start in the same second;
    // a new server revision, rather than elapsed time, owns the new execution.
    const finished = snapshot().latestAgentTurns[0]!;
    for (const [index, requestId] of [finished.requestId, 'next-request'].entries()) {
      const restarted: RoomViewAgentTurn = {
        ...finished,
        requestId,
        status: 'working',
        version: finished.version! + index + 1,
      };
      act(() => publishPhoneLiveEvent({ type: 'turn-delta', roomId: R, turn: restarted }));
      expect(label()).not.toBe('');
      act(() => offerRoomTurns(scope, R, [finished], currentSurfaceStamp()));
      expect(snapshot().latestAgentTurns[0]).toEqual(restarted);
    }
  } finally {
    releases.forEach((release) => release());
    if (tree) act(() => tree.unmount());
    stop();
    socket?.terminate();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    resetClientState();
  }
}, 60_000);
