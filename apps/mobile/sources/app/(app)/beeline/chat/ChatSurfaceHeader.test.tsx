import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: 'RepositoryMark' }));
vi.mock('tamagui', () => ({ ListItem: 'ListItem', XStack: 'XStack', YStack: 'YStack' }));
vi.mock('lucide-react-native', () => ({ ArrowLeft: 'ArrowLeft', MessagesSquare: 'MessagesSquare', MoreHorizontal: 'MoreHorizontal', Settings: 'Settings' }));
vi.mock('@/ui/grammar', async () => {
  const { createElement } = await import('react');
  return {
    Btn: 'Btn', Glyph: 'Glyph', T: 'T', SafeTop: 'SafeTop', ChatMark: 'ChatMark',
    ChatName: ({ name, testID }: any) => createElement('ChatName', { testID }, name),
    PlaceHeader: (p: any) => createElement('PlaceHeader', { testID: p.testID },
      p.back ? createElement('Btn', { testID: p.backTestID, onPress: p.back }) : null, p.mark, p.title, p.meta, p.right),
  };
});
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
vi.mock('@/ui/screens/thread/ThreadHeader', () => ({ ThreadBar: 'ThreadBar' }));
import { ChatSurfaceHeaderView } from './ChatSurfaceHeader';

const byTestID = (tree: any, testID: string) => tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string');
const base = {
  isCorner: false, isDirectMessage: false, showBack: true, handleBack: vi.fn(), title: '#beeline', memberCount: 5,
  openChatInfo: vi.fn(), openMembers: vi.fn(), dmHeaderPresence: '', threadCollapsed: false, openParentChat: vi.fn(),
};

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('is #name over a plain member count with ⚙, and no faces or repository', () => {
  const openChatInfo = vi.fn(), openMembers = vi.fn();
  let tree: any;
  act(() => { tree = create(<ChatSurfaceHeaderView {...base} openChatInfo={openChatInfo} openMembers={openMembers} />); });
  expect(byTestID(tree, 'chat-title')[0].props.children).toBe('#beeline');
  expect(byTestID(tree, 'chat-members-link')[0].findByType('T').props.children).toBe('5 members');
  expect(tree.root.findAllByType('IdentityMark')).toHaveLength(0);
  act(() => byTestID(tree, 'chat-title-link')[0].props.onPress());
  act(() => byTestID(tree, 'chat-settings')[0].props.onPress());
  expect(openChatInfo).toHaveBeenCalledTimes(2);
  act(() => byTestID(tree, 'chat-members-link')[0].props.onPress());
  expect(openMembers).toHaveBeenCalledTimes(1);
  expect(byTestID(tree, 'chat-back')).toHaveLength(1);
  act(() => tree.update(<ChatSurfaceHeaderView {...base} showBack={false} memberCount={1} title={null} />));
  expect(byTestID(tree, 'chat-back')).toHaveLength(0);
  expect(byTestID(tree, 'chat-title-skeleton')).toHaveLength(1);
  expect(byTestID(tree, 'chat-members-link')[0].findByType('T').props.children).toBe('1 member');
  act(() => tree.unmount());
});

it('names a DM’s peer with its mark and presence, and keeps its actions', () => {
  const openDmActions = vi.fn();
  let tree: any;
  act(() => {
    tree = create(<ChatSurfaceHeaderView {...base} isDirectMessage title="@alan" dmHeaderPresence="Yours · Claude Opus 5.5"
      dmPeer={{ kind: 'agent', seed: 'alan' }} openDmActions={openDmActions} />);
  });
  expect(tree.root.findByType('IdentityMark').props.kind).toBe('agent');
  expect(byTestID(tree, 'room-header-meta')[0].props.children).toBe('Yours · Claude Opus 5.5');
  expect(byTestID(tree, 'chat-settings')).toHaveLength(0);
  act(() => byTestID(tree, 'dm-actions-menu')[0].props.onPress());
  expect(openDmActions).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('gives a thread header B', () => {
  const thread = { chatTag: '#beeline', title: 'Reconnect keeps place', state: 'review' as const, running: 0 };
  let tree: any;
  act(() => { tree = create(<ChatSurfaceHeaderView {...base} isCorner thread={thread} threadCollapsed />); });
  const bar = tree.root.findByType('ThreadBar');
  expect(bar.props.h).toBe(thread);
  expect(bar.props.collapsed).toBe(true);
  expect(byTestID(tree, 'chat-header')).toHaveLength(0);
  act(() => tree.unmount());
});

it('shows the repository owner image on the chat header', () => {
  let tree: any;
  act(() => { tree = create(<ChatSurfaceHeaderView {...base} repositoryAvatar="https://avatars.githubusercontent.com/u/42" repositoryFavicon="https://github.githubassets.com/favicons/favicon.png" />); });
  expect(tree.root.findByType('RepositoryMark').props).toMatchObject({avatarUrl:'https://avatars.githubusercontent.com/u/42',faviconUrl:'https://github.githubassets.com/favicons/favicon.png'});
  act(() => tree.unmount());
});
