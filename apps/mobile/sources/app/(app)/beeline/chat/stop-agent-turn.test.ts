import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { alert, operation, MonolithRequestTimeoutError } = vi.hoisted(() => ({
  alert: vi.fn(), operation: vi.fn(), MonolithRequestTimeoutError: class extends Error {},
}));
vi.mock('@/modal', () => ({ Modal: { alert: (...args: unknown[]) => alert(...args) } }));
vi.mock('@/auth/monolith-session', () => ({
  MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
  MonolithRequestTimeoutError,
  monolithSession: { authorization: async () => 'fixture-access', invalidateAuthorization: vi.fn() },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: (...args: unknown[]) => operation(...args),
  phoneOperationFailureReason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { requestAgentTurnStop } from './stop-agent-turn';

const stop = { agentPubkey: 'agent', requestId: 'request' };

beforeEach(() => {
  alert.mockReset();
  operation.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

it('shows a dialog and rereads the Room when the server refuses Stop', async () => {
  operation.mockRejectedValue(new Error('running turn not found'));
  const readRoom = vi.fn();
  expect(await requestAgentTurnStop('room', stop, readRoom)).toBe(false);
  expect(operation).toHaveBeenCalledWith(
    'cancelAgentTurn',
    { roomId: 'room', requestId: 'request', agentId: 'agent' },
    { recoverSilentSocket: true },
  );
  expect(alert).toHaveBeenCalledWith('Stop failed', 'running turn not found');
  expect(readRoom).toHaveBeenCalledTimes(1);
});

it('names an unknown result when Stop times out', async () => {
  operation.mockRejectedValue(new MonolithRequestTimeoutError('timed out'));
  const readRoom = vi.fn();
  expect(await requestAgentTurnStop('room', stop, readRoom)).toBe(false);
  expect(operation).toHaveBeenCalledWith(
    'cancelAgentTurn',
    { roomId: 'room', requestId: 'request', agentId: 'agent' },
    { recoverSilentSocket: true },
  );
  expect(readRoom).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith('Stop result unknown', 'timed out');
});

it('shows nothing when Stop succeeds', async () => {
  operation.mockResolvedValue({});
  const readRoom = vi.fn();
  expect(await requestAgentTurnStop('room', stop, readRoom)).toBe(true);
  expect(alert).not.toHaveBeenCalled();
  expect(readRoom).not.toHaveBeenCalled();
});

describe('half-open silent socket recovery', () => {
  afterEach(async () => {
    const live = await import('@/sync/transport/live-connection').catch(() => undefined);
    live?.resetSharedLiveConnection();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('replaces a silent half-open WebSocket before running the recovery readRoom without replaying cancelAgentTurn', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    class FakeSocket {
      static instances: FakeSocket[] = [];
      readyState = 0;
      sent: string[] = [];
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { FakeSocket.instances.push(this); }
      send(frame: string) { this.sent.push(frame); }
      close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.(); }
      requests() { return this.sent.map(v => JSON.parse(v)).filter(frame => frame.t === 'req'); }
      reply(result: unknown, index = 0) {
        this.onmessage?.({ data: JSON.stringify({ t: 'res', id: this.requests()[index].id, ok: true, result }) });
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.doMock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
    vi.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      NativeModules: {},
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    }));
    vi.doMock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));
    vi.doUnmock('@/sync/transport/monolith-operation');

    const { sharedLiveConnection, useConnectionFailure } = await import('@/sync/transport/live-connection');
    const { requestAgentTurnStop: realStop } = await import('./stop-agent-turn');
    const connection = sharedLiveConnection();
    await connection.register([{ '#h': ['room-a'] }], () => {});
    await vi.advanceTimersByTimeAsync(0);
    const deadSocket = FakeSocket.instances[0]!;
    deadSocket.open();

    // Open socket silently drops every frame (readyState stays 1, no close/error).
    let roomReadPromise: Promise<unknown> | undefined;
    const stopPromise = realStop('room-a', stop, () => {
      roomReadPromise = connection.request('readRoom', { roomId: 'room-a' });
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deadSocket.requests().map(r => r.op)).toEqual(['cancelAgentTurn']);

    // 20s cancelAgentTurn timeout + 2.5s one-shot ping liveness bound.
    await vi.advanceTimersByTimeAsync(20_000 + 2_500);
    expect(await stopPromise).toBe(false);
    expect(deadSocket.sent).toContain('{"type":"ping"}');
    expect(deadSocket.readyState).toBe(3);
    expect(alert).toHaveBeenCalledWith('Stop result unknown', expect.any(String));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(useConnectionFailure()).toBe(false);

    // Recovery readRoom confirms the replacement socket on its own: neither readWorkspaces nor cancelAgentTurn is sent.
    const freshSocket = FakeSocket.instances[1]!;
    freshSocket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(deadSocket.requests().map(r => r.op)).toEqual(['cancelAgentTurn']);
    expect(freshSocket.requests().map(r => r.op)).toEqual(['readRoom']);
    expect(freshSocket.requests().some(r => r.op === 'readWorkspaces')).toBe(false);
    expect(freshSocket.requests().some(r => r.op === 'cancelAgentTurn')).toBe(false);
    freshSocket.reply({ room: { id: 'room-a', archived: true }, latestAgentTurns: [] }, 0);
    await expect(roomReadPromise).resolves.toEqual({ room: { id: 'room-a', archived: true }, latestAgentTurns: [] });
    expect(useConnectionFailure()).toBe(false);
  });
});
