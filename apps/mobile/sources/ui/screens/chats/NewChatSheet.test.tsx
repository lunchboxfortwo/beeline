import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: (props: any) => React.createElement('RepositoryMark', props) }));
vi.mock('tamagui', async () => (await import('./tamagui-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./tamagui-hosts.test-support')).lucideHosts());
vi.mock('react-native-svg', async () => ({ ...(await import('./tamagui-hosts.test-support')).svgHosts(), Line: (props: any) => React.createElement('Line', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }),
  Platform: { OS: 'web' },
  FlatList: ({ data, renderItem, ListFooterComponent, ListEmptyComponent, ...props }: any) => React.createElement('FlatList', props,
    data.length ? data.slice(0, 10).map((item: any, index: number) => React.createElement(React.Fragment, { key: item.key }, renderItem({ item, index }))) : ListEmptyComponent,
    ListFooterComponent),
}));

import { NewChatSheet, type NewChatSheetProps, type NewChatStep } from './NewChatSheet';
import { ChatListHeader, CLOSED_SEARCH, type ChatSearch } from './ChatListHeader';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const byTestID = (tree: ReactTestRenderer, id: string) =>
  tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);

function sheet(step: NewChatStep | null, overrides: Partial<NewChatSheetProps> = {}) {
  const props: NewChatSheetProps = {
    step,
    onStep: vi.fn(),
    busy: false,
    name: '',
    onName: vi.fn(),
    onCreateEmpty: vi.fn(),
    candidates: [
      { key: 'github:1', name: 'lunchboxfortwo/burdbook', private: true },
      { key: 'github:2', name: 'Beeline-Work/beeline', private: false },
    ],
    installations: [],
    loading: false,
    error: null,
    notice: null,
    onLoadRepositories: vi.fn(),
    onConnectGitHub: vi.fn(),
    onPickRepository: vi.fn(),
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<NewChatSheet {...props} />); });
  return { tree, props };
}

it('offers Start empty and Attach a GitHub repository, with no templates', () => {
  const { tree, props } = sheet('menu');
  const frame = tree.root.find((node: any) => node.type === 'Sheet');
  expect(frame.props.open).toBe(true);
  expect(byTestID(tree, 'new-chat-empty').props['aria-label']).toBe('Start empty');
  expect(byTestID(tree, 'new-chat-github').props['aria-label']).toBe('Attach a GitHub repository…');
  expect(tree.root.findAll((node: any) => node.props['aria-label']?.includes('template'))).toHaveLength(0);
  act(() => byTestID(tree, 'new-chat-github').props.onPress());
  expect(props.onStep).toHaveBeenCalledWith('github');
  expect(props.onLoadRepositories).toHaveBeenCalledOnce();
});

it('finds and picks a repository; a private one carries the lock', () => {
  const { tree, props } = sheet('github');
  expect(tree.root.findAll((node: any) => node.type === 'Icon.Lock')).toHaveLength(1);
  act(() => byTestID(tree, 'repo-search').props.onChangeText('beel'));
  expect(tree.root.findAll((node: any) => node.type === 'ListItem' && node.props.testID?.startsWith('repo-row-'))
    .map((node: any) => node.props['aria-label'])).toEqual(['Beeline-Work/beeline']);
  act(() => byTestID(tree, 'repo-row-github:2').props.onPress());
  expect(props.onPickRepository).toHaveBeenCalledWith(expect.objectContaining({ key: 'github:2' }));
  act(() => byTestID(tree, 'repo-search').props.onChangeText('nothing'));
  expect(tree.root.findAll((node: any) => node.props.children === 'No repositories match.')).not.toHaveLength(0);
});

it('asks to connect GitHub when no repository is reachable', () => {
  const { tree, props } = sheet('github', { candidates: [] });
  act(() => byTestID(tree, 'repo-connect-github').props.onPress());
  expect(props.onConnectGitHub).toHaveBeenCalledOnce();
});

it('defers offscreen repositories when opening and can still find and select the last one', () => {
  const candidates = Array.from({ length: 1000 }, (_, index) => ({ key: `repo-${index}`, name: `owner/repository-${index}` }));
  const { tree, props } = sheet('github', { candidates });
  expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'repo-row-repo-999')).toHaveLength(0);
  act(() => byTestID(tree, 'repo-search').props.onChangeText('repository-999'));
  act(() => byTestID(tree, 'repo-row-repo-999').props.onPress());
  expect(props.onPickRepository).toHaveBeenCalledWith(candidates[999]);
});

it('starts an empty chat only from a valid name, public by default', () => {
  const invalid = sheet('empty', { name: 'Bad Name' });
  expect(byTestID(invalid.tree, 'create-room-submit').props.disabled).toBe(true);
  expect(byTestID(invalid.tree, 'create-room-name-hint')).toBeDefined();
  const valid = sheet('empty', { name: 'launch' });
  act(() => byTestID(valid.tree, 'create-room-submit').props.onPress());
  expect(valid.props.onCreateEmpty).toHaveBeenCalledWith('launch', false);
  act(() => byTestID(valid.tree, 'create-room-public').props.onCheckedChange(false));
  act(() => byTestID(valid.tree, 'create-room-submit').props.onPress());
  expect(valid.props.onCreateEmpty).toHaveBeenLastCalledWith('launch', true);
});

it('switches the list header to a search field with Unread and Pinned chips', () => {
  let search: ChatSearch = CLOSED_SEARCH;
  const onSearch = vi.fn((next: ChatSearch) => { search = next; });
  const render = () => <ChatListHeader workspaceName="Beeline Work" onWorkspace={() => undefined} search={search} onSearch={onSearch} />;
  let tree!: ReactTestRenderer;
  act(() => { tree = create(render()); });
  expect(tree.root.findAllByProps({ testID: 'new-chat' })).toHaveLength(0);
  expect(byTestID(tree, 'workspace-switcher').props['aria-label']).toBe('Workspace: Beeline Work. Switch workspace');
  act(() => byTestID(tree, 'room-search-open').props.onPress());
  act(() => tree.update(render()));
  const chips = tree.root.find((node: any) => node.type === 'ToggleGroup');
  expect(chips.props.type).toBe('multiple');
  act(() => chips.props.onValueChange(['unread']));
  expect(search).toEqual({ open: true, query: '', chips: ['unread'] });
  act(() => byTestID(tree, 'room-search-close').props.onPress());
  expect(search).toEqual(CLOSED_SEARCH);
});

it('shows repository candidate owner photos and favicon fallbacks in New chat', () => {
  const candidates = [
    { key: 'github:1', name: 'Beeline-Work/beeline', avatarUrl: 'https://avatars.githubusercontent.com/u/42', faviconUrl: 'https://github.githubassets.com/favicons/favicon.png' },
    { key: 'github:2', name: 'other/repo', faviconUrl: 'https://github.githubassets.com/favicons/favicon.png' },
    { key: 'github:3', name: 'local/repo' },
  ];
  const { tree } = sheet('github', { candidates });
  for (const candidate of candidates) {
    const mark = byTestID(tree, `repo-row-${candidate.key}`).findByType('RepositoryMark');
    expect(mark.props).toMatchObject({ avatarUrl: candidate.avatarUrl, faviconUrl: candidate.faviconUrl });
  }
  expect(tree.root.findAll((node: any) => node.type === 'Icon.GitBranch')).toHaveLength(0);
});

it('shows the full selected name in a removable pill while keeping immediate selection', () => {
  const name = 'Beeline-Work/repository-selection-with-a-long-name-that-wraps';
  const { tree, props } = sheet('github', { candidates: [{ key: 'long', name }] });
  expect(tree.root.findAllByProps({ testID: 'new-chat-repository-pill' })).toHaveLength(0);
  act(() => byTestID(tree, 'repo-row-long').props.onPress());
  expect(props.onPickRepository).toHaveBeenCalledOnce();
  const pill = byTestID(tree, 'new-chat-repository-pill');
  const text = pill.find((node: any) => node.type === 'Text' && node.props.children === name);
  expect(text.props.numberOfLines).toBeUndefined();
  act(() => byTestID(tree, 'new-chat-repository-clear').props.onPress());
  expect(tree.root.findAllByProps({ testID: 'new-chat-repository-pill' })).toHaveLength(0);
  expect(props.onPickRepository).toHaveBeenCalledOnce();
});
