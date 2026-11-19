import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const pointer = vi.hoisted(() => ({ fine: true }));
vi.mock('@/ui/screens/tags/WorkMarks', () => ({ WorkStateMark: (props: any) => React.createElement('WorkStateMark', props) }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 800, width: 1280 }) }));
vi.mock('tamagui', async () => (await import('./tamagui-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./tamagui-hosts.test-support')).lucideHosts());
vi.mock('react-native-svg', async () => (await import('./tamagui-hosts.test-support')).svgHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/buzz/message-outbox-observer', () => ({ useRoomOutboxFailure: () => null }));
vi.mock('@/buzz/room-corner-store', () => ({ useRoomCornerSummary: () => null }));
vi.mock('@/components/buzz/Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: () => null }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/utils/use-fine-pointer', () => ({ useFinePointer: () => pointer.fine }));

import type { ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { HEIGHT } from '@/ui/grammar';
import { DesktopChatList } from './DesktopChatList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = 'viewer';
const NOW = 1_700_000_000_000;
const chat = (id: string, extra: Partial<ChatListItem> = {}) =>
  ({ room: { id, name: id, updatedAt: NOW / 1000 - 60 }, openCorners: [], unread: false, ...extra }) as unknown as ChatListItem;
const dm = (id: string) => chat(id, { directMessage: { peer: { kind: 'human', pubkey: id, name: id } } } as any);
const corner = (id: string, personId: string): ChatListCorner =>
  ({ id, name: id, state: 'waiting', reason: 'question', blocker: { kind: 'message', personId } }) as ChatListCorner;

function render(chats: ChatListItem[], selected: string | null = null) {
  const handlers = { onOpen: vi.fn(), onPin: vi.fn(), onOpenThread: vi.fn() };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<DesktopChatList chats={chats} now={NOW} viewer={VIEWER} selected={selected} pinned={[]}
      corners={(item) => item.openCorners} {...handlers} />);
  });
  return { tree, ...handlers };
}
const ids = (tree: ReactTestRenderer, prefix: string): string[] =>
  tree.root.findAll((node: any) => typeof node.type === 'string' && String(node.props.testID ?? '').startsWith(prefix))
    .map((node: any) => node.props.testID as string);
const section = (tree: ReactTestRenderer, title: string) =>
  tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === `section-${title}`);

it('lists only threads waiting on the viewer under Waiting on you, not mentions or others’ waits', () => {
  const tagged = chat('design', { unread: true, mentionsViewer: true } as any);
  const { tree } = render([
    chat('beeline', { openCorners: [corner('mine', VIEWER), corner('theirs', 'someone-else')] } as any),
    tagged,
  ]);
  expect(ids(tree, 'thread-row-')).toEqual(['thread-row-mine']);
  expect(section(tree, 'Waiting on you')).toHaveLength(1);
  // The mentioned chat stays in Chats only.
  expect(ids(tree, 'room-design').filter((id) => id === 'room-design')).toHaveLength(1);
});

it('hides Waiting on you when nothing waits', () => {
  const { tree } = render([chat('a')]);
  expect(section(tree, 'Waiting on you')).toHaveLength(0);
});

it('caps Chats at 8 and Direct messages at 5 behind Show all N, keeping the open chat visible', () => {
  const chats = Array.from({ length: 12 }, (_, i) => chat(`c${i}`));
  const dms = Array.from({ length: 6 }, (_, i) => dm(`d${i}`));
  const { tree } = render([...chats, ...dms], 'c11');
  const rows = () => ids(tree, 'room-').filter((id) => !id.includes('-', 5));
  expect(rows().filter((id) => id.startsWith('room-c'))).toEqual([...Array.from({ length: 8 }, (_, i) => `room-c${i}`), 'room-c11']);
  expect(rows().filter((id) => id.startsWith('room-d'))).toHaveLength(5);
  const more = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'show-all-Chats');
  expect(more.props['aria-label']).toBe('Show all 12 chats');
  act(() => more.props.onPress());
  expect(rows().filter((id) => id.startsWith('room-c'))).toHaveLength(12);
});

it('marks unread chats semibold and keeps 44 pt rows for touch', () => {
  pointer.fine = false;
  const { tree } = render([chat('a', { unread: true } as any), chat('b')]);
  const title = (id: string) => tree.root.find((node: any) => node.props.testID === `room-${id}-title`);
  expect(title('a').props.v).toBe('metaStrong');
  expect(title('b').props.v).toBe('meta');
  const row = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'room-a');
  expect(row.props.minHeight).toBe(HEIGHT.control);
  expect(row.props.role).toBe('button');
  pointer.fine = true;
});
