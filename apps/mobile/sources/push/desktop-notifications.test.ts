import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  summaries: new Map<string, { cornerCount: number; revision: number }>(),
  summaryListeners: new Set<() => void>(),
  corners: vi.fn(async (_roomId: string) => ({ corners: [] })),
}));

vi.mock('@/utils/isTauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => true, requestPermission: async () => 'granted' }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }), getEffectiveRelayUrl: async () => 'http://relay',
}));
vi.mock('@/sync/client-reset', () => ({ subscribeClientReset: () => () => {} }));
vi.mock('@/buzz/open-room-tracker', () => ({ getOpenBuzzChannelId: () => null }));
vi.mock('./buzz-push-registration', () => ({ getBuzzPushEnabled: async () => true }));
vi.mock('./push-level-storage', () => ({ loadStoredPushLevel: async () => 'all' }));
vi.mock('@/buzz/managed-identity-surface', () => ({ readManagedIdentity: async () => null }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async ensureClient() { return { surfaceSubscribe: async () => () => {} }; }
    subscribeConnected() { return () => {}; }
  },
  RoomViewClient: class {
    async workspaces() { return { workspaces: [{ id: 'workspace' }] }; }
    corners(roomId: string) { return fixture.corners(roomId); }
  },
}));
vi.mock('@/buzz/chat-list-store', () => ({
  acquireChatList: () => ({
    current: () => ({ chats: ['parent-a', 'parent-b'].map((id) => ({ room: { id, name: id } })), watchFilters: [] }),
    subscribe: () => () => {}, release() {}, force() {},
  }),
}));
vi.mock('@/buzz/room-corner-store', () => ({
  applyCornerListRead() {},
  cornerReadMark: () => ({}),
  getRoomCorners: () => [],
  roomOpenCornerRows: () => [],
  getRoomCornerSummary: (roomId: string) => fixture.summaries.get(roomId),
  subscribeRoomCornerSummaries: (listener: () => void) => {
    fixture.summaryListeners.add(listener);
    return () => fixture.summaryListeners.delete(listener);
  },
}));

import { startDesktopNotifications } from './desktop-notifications';

it('re-reads corners only for the parent whose corner summary changed', async () => {
  fixture.summaries.set('parent-a', { cornerCount: 1, revision: 1 });
  fixture.summaries.set('parent-b', { cornerCount: 2, revision: 1 });
  const stop = startDesktopNotifications();
  await vi.waitFor(() => expect(fixture.corners).toHaveBeenCalledTimes(2));
  expect(fixture.corners.mock.calls.map(([roomId]) => roomId).sort()).toEqual(['parent-a', 'parent-b']);

  fixture.corners.mockClear();
  fixture.summaries.set('parent-a', { cornerCount: 1, revision: 2 });
  for (const listener of fixture.summaryListeners) listener();
  await vi.waitFor(() => expect(fixture.corners).toHaveBeenCalledOnce());
  expect(fixture.corners).toHaveBeenCalledWith('parent-a');

  fixture.corners.mockClear();
  for (const listener of fixture.summaryListeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fixture.corners).not.toHaveBeenCalled();
  stop();
});
