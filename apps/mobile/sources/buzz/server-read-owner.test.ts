import { afterEach, expect, it, vi } from 'vitest';
import type { ChatListView } from '@beeline/buzz-client';
const io = vi.hoisted(() => ({ chats: vi.fn(), value: null as ChatListView | null }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  peekBuzzViewerContext: () => null,
}));
vi.mock('@/sync/client-reset', () => ({ subscribeClientReset: () => () => {} }));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({ register: async () => () => {}, isViewing: () => false }),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    chats = io.chats;
  },
}));
vi.mock('./room-message-records', () => ({ indexedPreviewId: () => undefined }));
vi.mock('./room-live-state', () => ({ observeRoomLiveState: () => {} }));
vi.mock('./room-corner-store', () => ({
  applyChatListCorners: () => {},
  cornerStoreClock: () => 0,
  getRoomCornerSummary: () => undefined,
}));
vi.mock('./surface-storage', () => ({
  surfaceAddress: () => 'chats',
  mobileSurfaceCache: {
    peek: () => io.value,
    read: async () => io.value,
    publish: (_address: unknown, value: ChatListView) => {
      io.value = value;
    },
    persist: async () => {},
    subscribe: () => () => {},
    clear: () => {
      io.value = null;
    },
  },
}));
import { acquireChatList, readChatList, resetChatListStoresForTest } from './server-read-owner';
const key = { relayUrl: 'https://server.test', viewerPubkey: 'viewer', workspaceId: 'workspace' };
const view = (name: string) =>
  ({
    workspace: { id: 'workspace', name },
    chats: [],
    watchFilters: [],
    viewer: {},
  }) as unknown as ChatListView;
afterEach(() => {
  resetChatListStoresForTest();
  vi.clearAllMocks();
});

it('waits for a post-action list read despite cached and older in-flight answers', async () => {
  io.value = view('cached');
  const pending: Array<(value: ChatListView) => void> = [];
  io.chats.mockImplementation(() => new Promise<ChatListView>((resolve) => pending.push(resolve)));
  const held = acquireChatList(key, { visible: () => true });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()!(view('confirmed before close'));
  await vi.waitFor(() => expect(held.confirmed()).toBe(true));
  expect(await readChatList(key)).toEqual(view('confirmed before close'));
  held.force();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  let settled = false;
  const fresh = readChatList(key, true).then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending.shift()!(view('old in-flight answer'));
  await vi.waitFor(() => expect(held.current()?.workspace.name).toBe('old in-flight answer'));
  expect(settled).toBe(false);
  pending.shift()!(view('after close'));
  expect(await fresh).toEqual(view('after close'));
  held.release();
});
