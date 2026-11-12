import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: (props: any) => React.createElement('RepositoryMark', props) }));
vi.mock('tamagui', () => ({ ListItem: 'ListItem', XStack: 'XStack', YStack: 'YStack' }));
vi.mock('lucide-react-native', () => ({ ArrowLeft: 'ArrowLeft', CornerDownRight: 'CornerDownRight', GitPullRequest: 'GitPullRequest', MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/ui/grammar', () => ({ Btn: 'Btn', Glyph: 'Glyph', T: 'T', SafeTop: 'SafeTop', HEIGHT: { control: 44 } }));
import { ThreadBar, ThreadTitleBlock, type ThreadHeaderData } from './ThreadHeader';

const byTestID = (tree: any, testID: string) => tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string');
const reconnect: ThreadHeaderData = {
  chatTag: '#beeline', title: 'Reconnect keeps place', state: 'review', running: 2,
  prLine: '#4181 · Open · All 14 checks passed',
  objective: 'Keep the transcript still when the connection returns.',
};

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('draws the title block: title, brass status with the running count, PR row, objective and Read the brief', () => {
  const openBrief = vi.fn(), openPr = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadTitleBlock h={reconnect} openBrief={openBrief} openPr={openPr} />); });
  expect(byTestID(tree, 'thread-title')[0].props.children).toBe('Reconnect keeps place');
  const status = byTestID(tree, 'thread-status')[0].findByType('T');
  expect(status.props.children).toBe('In review · 2 running');
  expect(status.props.color).toBe('needsYou');
  expect(byTestID(tree, 'thread-status-dot')[0].props.backgroundColor).toBe('needsYou');
  const pr = byTestID(tree, 'thread-pr')[0];
  expect(pr.findByType('T').props.children).toBe('#4181 · Open · All 14 checks passed');
  act(() => pr.props.onPress());
  expect(openPr).toHaveBeenCalledTimes(1);
  const brief = byTestID(tree, 'thread-brief')[0];
  expect(brief.findAllByType('T').map((node: any) => node.props.children)).toEqual([reconnect.objective, 'Read the brief']);
  act(() => brief.props.onPress());
  expect(openBrief).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('shows a quiet thread without a running count or PR, and its dot in the strong stroke', () => {
  let tree: any;
  act(() => { tree = create(<ThreadTitleBlock h={{ chatTag: '#beeline', title: 'Owed commands', state: 'idle', running: 0 }} />); });
  expect(byTestID(tree, 'thread-status')[0].findByType('T').props.children).toBe('Idle');
  expect(byTestID(tree, 'thread-status')[0].findByType('T').props.color).toBe('secondary');
  expect(byTestID(tree, 'thread-status-dot')[0].props.backgroundColor).toBe('strongStroke');
  expect(byTestID(tree, 'thread-pr')).toHaveLength(0);
  expect(byTestID(tree, 'thread-brief')).toHaveLength(0);
  act(() => tree.unmount());
});

it('keeps the bar slim, and gives it the title with a status dot once the block scrolls away', () => {
  const openChat = vi.fn(), openActions = vi.fn(), back = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadBar h={{ ...reconnect, state: 'working' }} collapsed={false} back={back} openChat={openChat} openActions={openActions} />); });
  const chat = byTestID(tree, 'thread-chat-link')[0];
  expect(chat.findByType('T').props.children).toBe('#beeline');
  expect(chat.findByType('T').props.color).toBe('needsYou');
  act(() => chat.props.onPress());
  expect(openChat).toHaveBeenCalledTimes(1);
  expect(byTestID(tree, 'thread-bar-title')).toHaveLength(0);
  act(() => byTestID(tree, 'corner-actions-menu')[0].props.onPress());
  expect(openActions).toHaveBeenCalledTimes(1);
  act(() => tree.update(<ThreadBar h={{ ...reconnect, state: 'working' }} collapsed back={back} openChat={openChat} openActions={openActions} />));
  const title = byTestID(tree, 'thread-bar-title')[0];
  expect(title.findByType('T').props.children).toBe('Reconnect keeps place');
  expect(byTestID(tree, 'thread-status-dot')[0].props.backgroundColor).toBe('added');
  act(() => tree.unmount());
});

it('expands the full header from a tap on the slim bar, and shows it under the bar', () => {
  const expand = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadBar h={reconnect} collapsed openChat={vi.fn()} expand={expand} />); });
  act(() => byTestID(tree, 'thread-bar-title')[0].props.onPress());
  expect(expand).toHaveBeenCalledTimes(1);
  act(() => tree.update(<ThreadBar h={reconnect} collapsed openChat={vi.fn()} expand={expand} expanded={<ThreadTitleBlock h={reconnect} />} />));
  expect(byTestID(tree, 'thread-bar-title')).toHaveLength(0);
  expect(byTestID(tree, 'thread-title')[0].props.children).toBe('Reconnect keeps place');
  act(() => tree.unmount());
});

it('keeps the repository mark beside the parent chat in a thread header', () => {
  let tree: any;
  act(() => { tree = create(<ThreadBar h={{...reconnect,repositoryAvatar:'https://avatars.githubusercontent.com/u/42'}} collapsed={false} openChat={vi.fn()} />); });
  expect(tree.root.findByType('RepositoryMark').props.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42');
  act(() => tree.unmount());
});
