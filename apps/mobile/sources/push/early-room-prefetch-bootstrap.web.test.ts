import { afterEach, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({
  room: vi.fn(),
  chats: vi.fn(),
  cached: vi.fn(),
  viewer: vi.fn(async () => 'viewer'),
}));
vi.mock('./push-room-prefetch', () => ({ prefetchPushRoom: reads.room }));
vi.mock('@/buzz/chat-list-store', () => ({ readChatList: reads.chats }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzViewerPubkey: reads.viewer,
  getEffectiveRelayUrl: async () => 'https://server.fixture',
}));
vi.mock('@/buzz/community-storage', () => ({ loadActiveCommunityId: async () => 'saved' }));
vi.mock('@/buzz/surface-storage', () => ({ restoreStoredSurface: reads.cached, surfaceAddress: vi.fn() }));

async function launch(path: string, saved = true) {
  vi.stubGlobal('window', {
    location: new URL(path, 'https://page.fixture'),
    __beelineLaunchLive: saved ? {} : undefined,
  });
  await import('./early-room-prefetch-bootstrap.web');
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

it('starts the requested Room read before React mounts', async () => {
  await launch('/beeline/chat/room%20one');
  expect(reads.room).toHaveBeenCalledExactlyOnceWith('room-open:room one', 'room one');
});
it('uses the cold deck’s own viewer and Workspace', async () => {
  await launch('/?communityId=chosen');
  await vi.waitFor(() => expect(reads.chats).toHaveBeenCalledExactlyOnceWith({
    relayUrl: 'https://server.fixture', viewerPubkey: 'viewer', workspaceId: 'chosen',
  }));
});
it('leaves a saved deck for the screen to paint', async () => {
  reads.cached.mockReturnValueOnce({});
  await launch('/');
  await vi.waitFor(() => expect(reads.cached).toHaveBeenCalled());
  expect(reads.chats).not.toHaveBeenCalled();
});
it('leaves signed-out and unrelated routes alone', async () => {
  await launch('/beeline/chat/room', false);
  vi.resetModules();
  await launch('/join/invite');
  expect(reads.room).not.toHaveBeenCalled();
  expect(reads.viewer).not.toHaveBeenCalled();
});
