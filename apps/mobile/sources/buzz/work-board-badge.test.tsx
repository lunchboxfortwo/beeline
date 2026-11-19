import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkBoardView, WorkItemView } from '@beeline/api-contract/phone';

const mock = vi.hoisted(() => ({
  workspace: 'ws', generation: 0, resets: new Set<() => void>(),
  frames: new Set<(event: unknown) => void>(), read: vi.fn(), register: vi.fn(),
  connected: vi.fn(() => () => undefined), cache: new Map<string, string>(),
}));
vi.mock('@/sync/client-reset', () => ({
  clientResetGeneration: () => mock.generation,
  subscribeClientReset: (listener: () => void) => {
    mock.resets.add(listener);
    return () => mock.resets.delete(listener);
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mock.read }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({ register: mock.register, subscribeConnected: mock.connected }),
}));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => mock.workspace }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  getEffectiveRelayUrl: async () => 'https://test.invalid',
  peekBuzzViewerContext: () => null,
}));
vi.mock('@/buzz/room-transition-work', () => ({
  deferRoomWrite: (_key: string, work: () => Promise<void>) => work(),
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  getString(key: string) { return mock.cache.get(key); }
  set(key: string, value: string) { mock.cache.set(key, value); }
  delete(key: string) { mock.cache.delete(key); }
  getAllKeys() { return [...mock.cache.keys()]; }
} }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default },
  AppState: { currentState: 'active' },
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/ui/shell/TabHeader', () => ({ TabHeader: () => null, useScrolledUnder: () => ({ scrolled: false, scrollProps: {} }) }));
vi.mock('@/ui/screens/tags/WorkItemDetail', () => ({ WorkSheet: () => null }));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/ui/shell/TabBar', () => ({ TabBar: (props: any) => React.createElement('TabBar', props) }));

import { useWorkBoard, loadWorkBoard } from './work-board-store';
import { PhoneTabBar } from '@/ui/shell/PhoneTabScreen';
import { WorkBoard } from '@/ui/screens/tags/WorkBoard';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { surfaceCacheKey } from '@beeline/buzz-client';

const person = { pubkey: 'agent', kind: 'agent' as const, name: 'Ruby' };
const item: WorkItemView = {
  id: 'task', roomId: 'chat', chatId: 'chat', chatName: 'general', threadName: 'Launch',
  title: 'Launch', state: 'needs-you', openedBy: person, assignee: null, createdAt: 1, updatedAt: 2,
};
const ask = {
  messageId: 'ask', workspaceId: 'ws', roomId: 'chat', roomName: 'general',
  roomKind: 'room' as const, author: person, text: 'Which surface?', createdAt: 1,
};
const board = (items: WorkItemView[], workspaceId = 'ws'): WorkBoardView => ({
  workspaceId, workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [], items,
});
const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
function Tasks() {
  const value = useWorkBoard(mock.workspace);
  return value ? <WorkBoard board={value} desktop={false} actions={actions} /> : null;
}
let tree: any;
const app = (tasks = true) => <><PhoneTabBar active="tags" />{tasks && <Tasks />}</>;
const count = () => tree.root.findByType('TabBar').props.tagsCount;
const asks = () => tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'work-ask-task');
const reset = () => { mock.generation++; for (const listener of mock.resets) listener(); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  reset(); mock.workspace = 'ws'; mock.cache.clear(); mobileSurfaceCache.clear();
  mock.read.mockReset().mockImplementation(async (operation) =>
    operation === 'readNeedsYou' ? { items: [ask] } : board([]),
  );
  mock.register.mockReset().mockImplementation(async (_filters, listener) => {
    mock.frames.add(listener);
    return () => mock.frames.delete(listener);
  });
  mock.connected.mockClear();
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

it('ignores the old needs-you disk cache and matches the board through zero, one and cleared asks', async () => {
  const address = surfaceAddress('https://test.invalid', 'viewer', '/workspace/:id/needs-you', { workspaceId: 'ws' });
  const key = `surface.${encodeURIComponent(surfaceCacheKey(address))}`;
  mock.cache.set(key, JSON.stringify({ items: [ask] }));
  // Even a work item in needs-you state does not count without an ask.
  mock.read.mockResolvedValueOnce(board([item]));
  await act(async () => { tree = create(app()); });
  expect(mock.cache.has(key)).toBe(true);
  expect(count()).toBe(0);
  expect(asks()).toHaveLength(0);
  expect(tree.root.findAll((n: any) => n.type === 'Text' && n.props.children === 'Nothing needs you now')).toHaveLength(1);
  expect(mock.read).toHaveBeenCalledExactlyOnceWith('readWorkBoard', { workspaceId: 'ws' });

  mock.read.mockResolvedValueOnce(board([{ ...item, state: 'in-progress', ask }]));
  await act(async () => { await loadWorkBoard('ws'); });
  expect(count()).toBe(1);
  expect(asks()).toHaveLength(1);

  mock.read.mockResolvedValueOnce(board([item]));
  await act(async () => { await loadWorkBoard('ws'); });
  expect(count()).toBe(0);
  expect(asks()).toHaveLength(0);
  expect(mock.read.mock.calls.every(([operation]) => operation === 'readWorkBoard')).toBe(true);
});

it('starts no read or connection when only the badge is mounted, and scopes held boards by Workspace and account', async () => {
  await act(async () => { tree = create(app(false)); });
  expect(count()).toBe(0);
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.register).not.toHaveBeenCalled();
  expect(mock.connected).not.toHaveBeenCalled();
  mock.read.mockResolvedValueOnce(board([{ ...item, ask }]));
  await act(async () => { tree.update(app()); });
  expect(count()).toBe(1);
  await act(async () => { tree.update(app(false)); });
  mock.workspace = 'other';
  await act(async () => { tree.update(app(false)); });
  expect(count()).toBe(0);
  mock.workspace = 'ws';
  await act(async () => { tree.update(app(false)); });
  expect(count()).toBe(1);
  await act(async () => reset());
  expect(count()).toBe(0);
  expect(mock.read).toHaveBeenCalledTimes(1);
});

it('does not let a remaining badge cause a follow-up read when Tasks unmounts during an invalidated read', async () => {
  let finish!: (value: WorkBoardView) => void;
  mock.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { tree = create(app()); });
  await act(async () => {
    for (const listener of mock.frames) listener({ monolithLive: { type: 'invalidate', reason: 'work-board-gap' } });
  });
  await act(async () => { tree.update(app(false)); });
  await act(async () => finish(board([{ ...item, ask }])));
  expect(count()).toBe(1);
  expect(mock.read).toHaveBeenCalledTimes(1);
});
