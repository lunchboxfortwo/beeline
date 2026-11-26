import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
const updates = vi.hoisted(() => ({
  updateId: '11111111-2222-3333-4444-555555555555',
  channel: 'production',
  runtimeVersion: '44',
  manifest: { metadata: { updateGroup: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
}));
const secure = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    store: {
      getItemAsync: vi.fn(async (key: string) => map.get(key) ?? null),
      setItemAsync: vi.fn(async (key: string, value: string) => {
        map.set(key, value);
      }),
      deleteItemAsync: vi.fn(async (key: string) => {
        map.delete(key);
      }),
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '44444444-4444-4444-8444-444444444444' }));
vi.mock('expo-updates', () => updates);
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
vi.mock('@/auth/monolith-secure-storage', () => ({
  monolithSecureStorage: async () => secure.store,
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.test' }),
}));
vi.mock('@/sync/appConfig', () => ({
  loadAppConfig: () => ({ releaseVersion: 'v0.1.248', releaseSha: '1'.repeat(40) }),
}));

import { monolithSession } from '@/auth/monolith-session';
import { resetSharedLiveConnection } from '@/sync/transport/live-connection';
import { reportRunningUpdateReceipt } from './update-receipt';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeSocket.instances.push(this);
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(index = 0) {
    const req = this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.t === 'req')[index];
    this.onmessage?.({ data: JSON.stringify({ t: 'res', id: req.id, ok: true, result: null }) });
  }
}

describe('shipped update receipt transport after token refresh', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    FakeSocket.instances = [];
    secure.map.clear();
    vi.clearAllMocks();
    resetSharedLiveConnection();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetSharedLiveConnection();
    vi.unstubAllGlobals();
  });

  it('refreshes expired credentials and sends reportRunningUpdate over the live socket once connected, never over HTTP', async () => {
    const identityId = 'a'.repeat(64);
    secure.map.set('buzzy.monolith.refresh.v1', 'brt_stored_refresh_token');
    secure.map.set('buzzy.monolith.identity.v1', identityId);
    secure.map.set(
      'buzzy.monolith.access.v1',
      JSON.stringify({
        token: 'bat_expired_access_token',
        expiresAt: Date.now() - 60_000,
        identityId,
      }),
    );

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://server.test/v1/auth/refresh') {
        return new Response(
          JSON.stringify({
            accessToken: 'bat_refreshed_access_token',
            accessExpiresAt: Date.now() + 900_000,
            refreshToken: 'brt_stored_refresh_token',
            refreshExpiresAt: Date.parse('9999-12-31T23:59:59.000Z'),
            identityId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected HTTP request: ${url}`);
    });

    // Ensure monolithSession starts with no in-memory access token so it refreshes via /v1/auth/refresh.
    monolithSession.invalidateAuthorization('bat_expired_access_token');

    const pending = reportRunningUpdateReceipt({
      publicKey: identityId,
      secretKey: new Uint8Array(32).fill(1),
    });

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('wss://server.test/v1/phone/live');
    expect(socket.protocols).toEqual(['bearer.bat_refreshed_access_token']);
    // Nothing is sent until the socket connects.
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!);
    expect(frame).toMatchObject({
      t: 'req',
      op: 'reportRunningUpdate',
      args: {
        deviceId: '44444444-4444-4444-8444-444444444444',
        platform: 'android',
        updateId: updates.updateId,
        channel: 'production',
        group: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        runtimeVersion: '44',
        releaseVersion: 'v0.1.248',
        sourceSha: '1'.repeat(40),
      },
    });

    socket.reply(0);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://server.test/v1/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
