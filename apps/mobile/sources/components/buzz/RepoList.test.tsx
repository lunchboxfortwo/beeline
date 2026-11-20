vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async () => () => undefined }) }));
vi.mock('@/auth/github-installation-host', () => ({ runHostGitHubInstallationSession: vi.fn() }));
vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => 'beeline://github-callback' }));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const keyboard = vi.hoisted(() => ({ height: { value: 0 } }));
const platform = vi.hoisted(() => ({ OS: 'android' }));
const bridge = vi.hoisted(() => ({ scrollBridge: { y: 0, hasScrollableContent: false }, setHasScrollView: vi.fn() }));
vi.mock('react-native-keyboard-controller', () => ({ useReanimatedKeyboardAnimation: () => keyboard }));
vi.mock('@/ui/window-dimensions', () => ({ useWindowDimensions: () => ({ height: 640, width: 360 }) }));
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: vi.fn() }));
vi.mock('react-native', () => ({ Platform: platform, useWindowDimensions: () => ({ height: 640, width: 360 }), VirtualizedList: 'VirtualizedList' }));
vi.mock('tamagui', async () => ({ ...(await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(), useSheetContext: () => bridge }));
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
vi.mock('./RepositoryMark', () => ({ RepositoryMark: 'RepositoryMark' }));
vi.mock('./EmptyState', () => ({ EmptyState: 'EmptyState' }));
vi.mock('./HullActionSheet', () => ({ HullActionSheetRow: 'HullActionSheetRow' }));
vi.mock('@/components/buzz/SelectedRepositoryPill', () => ({ SelectedRepositoryPill: 'SelectedRepositoryPill' }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
const operation = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('./HullDialog', () => ({ HullDialogInput: 'HullDialogInput' }));
vi.mock('@/ui/grammar', async importOriginal => ({ ...await importOriginal<typeof import('@/ui/grammar')>(), Placeheld: 'Placeheld' }));
vi.mock('@/buzz/use-text-draft', () => ({ useTextDraft: () => React.useState('') }));

import { RepoList } from './RepoList';
import { ChatRepositoryEditor } from '@/ui/screens/chat-info/ChatRepositoryEditor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This covers the data handoff to RN, not native scrolling or frame timing.
describe('Repository list data window', () => {
  it('does not inspect the full list on open and converts a distant row on demand', () => {
    const nameRead = vi.fn((index: number) => `owner/repo-${index}`);
    const candidates = Array.from({ length: 1000 }, (_, index) => ({
      key: `github:${index}`, get name() { return nameRead(index); },
    }));
    const onSelect = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<RepoList candidates={candidates} currentKey={null} loading={false}
      onSelect={onSelect} testIDPrefix="repos" draftContext="room" />); });
    expect(nameRead).not.toHaveBeenCalled();
    const list = tree!.root.findByType('VirtualizedList');
    expect(list.props.getItemCount(list.props.data)).toBe(1000);
    expect(bridge.setHasScrollView).toHaveBeenCalledWith(true);
    act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 400 } } }));
    expect(bridge.scrollBridge.y).toBe(400);
    expect(bridge.scrollBridge.hasScrollableContent).toBe(true);
    const item = list.props.getItem(list.props.data, 999);
    const row = list.props.renderItem({ item });
    expect(row.props.label).toBe('owner/repo-999');
    row.props.onPress();
    expect(onSelect).toHaveBeenCalledWith(candidates[999]);
    act(() => { tree!.unmount(); });
    expect(bridge.setHasScrollView).toHaveBeenLastCalledWith(false);
  });

  it('keeps search and selection available for repositories beyond the initial window', () => {
    const candidates = Array.from({ length: 1000 }, (_, index) => ({ key: `github:${index}`, name: `owner/repo-${index}` }));
    candidates[999].name = 'Beeline-Work/repository-selection-with-a-long-complete-name';
    const onSelect = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<RepoList candidates={candidates} currentKey="github:999" loading={false}
      onSelect={onSelect} testIDPrefix="repos" draftContext="room" />); });
    act(() => { tree!.root.findByType('Placeheld').props.onChangeText('BEELINE repository-selection'); });
    const list = tree!.root.findByType('VirtualizedList');
    expect(list.props.getItemCount(list.props.data)).toBe(1);
    const row = list.props.renderItem({ item: list.props.getItem(list.props.data, 0) });
    expect(row.props.selected).toBe(true);
    expect(row.props.label).toBe(candidates[999].name);
    expect(row.props.wrap).toBe(true);
    row.props.onPress();
    expect(onSelect).toHaveBeenCalledWith(candidates[999]);
    act(() => { tree!.unmount(); });
  });

  it('says no repositories are connected until a search matches nothing', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<RepoList candidates={[]} currentKey={null} loading={false}
      onSelect={vi.fn()} testIDPrefix="repos" draftContext="empty" />); });
    const empty = () => tree!.root.findByType('VirtualizedList').props.ListEmptyComponent.props.title;
    expect(empty()).toBe('No repositories connected.');
    act(() => { tree!.root.findByType('Placeheld').props.onChangeText('beeline'); });
    expect(empty()).toBe('No repos match.');
    act(() => { tree!.unmount(); });
  });
});

// Exercise the actual sheet keyboard budget and every ancestor between it and
// the native list. A non-shrinking fixed-height ancestor let rows escape that
// budget and cover the footer even though the sheet itself avoided the keyboard.
it.each(['android', 'ios', 'web'])('shrinks and clips the repo viewport above the footer with the keyboard open on %s', async os => {
  platform.OS = os;
  keyboard.height.value = -300;
  const candidates = Array.from({ length: 237 }, (_, index) => ({ key: `github:${index}`, name: `owner/repo-${index}` }));
  let tree: ReturnType<typeof create>;
  operation.mockResolvedValue({ repositories: candidates.map((candidate, index) => ({ id: index, fullName: candidate.name, installationId: 77, defaultBranch: 'main' })) });
  act(() => { tree = create(<ChatRepositoryEditor roomId="room" current={null} canEditRepository disabled={false}
    openCorners={0} refresh={vi.fn()} onBusyChange={vi.fn()} onOpen={vi.fn()} />); });
  await act(async () => tree!.root.findByType('ListItem').props.onPress());
  const list = tree!.root.findByType('VirtualizedList');
  const viewport = list.parent;
  expect(viewport.props.flexShrink).toBe(1);
  expect(viewport.props.minHeight).toBe(0);
  expect(viewport.props.overflow).toBe('hidden');
  const search = tree!.root.findByType('Placeheld');
  const root = search.parent;
  expect(root.props.flexShrink).toBe(1);
  expect(root.props.minHeight).toBe(0);
  expect(root.props.children[0].type).toBe('Placeheld');
  const body = tree!.root.findAll((node: any) => node.type === 'View' && Array.isArray(node.props.style))
    .find((node: any) => node.props.style.some((style: any) => style?.maxHeight !== undefined));
  expect(Object.assign({}, ...body.props.style)).toMatchObject({ maxHeight: 592, paddingBottom: 300, flexShrink: 1 });
  // Search and footer stay outside the virtualized scroll content; every repo
  // remains in that content after the keyboard consumes the sheet's height.
  expect(list.props.getItemCount(list.props.data)).toBe(237);
  expect(list.props.getItem(list.props.data, 236)).toMatchObject({ key: 'github:236', name: 'owner/repo-236' });
  const save = tree!.root.find((node: any) => node.type === 'Button' && node.props.testID === 'chat-repository-save');
  let footer = save.parent;
  while (footer.type !== 'XStack') footer = footer.parent;
  expect(footer.props.flexShrink).toBe(0);
  expect(footer.props.children.map((child: any) => child.props.label)).toEqual(['Cancel', 'Save']);
  expect(list.findAllByType('Placeheld')).toHaveLength(0);
  expect(list.findAllByType('Button')).toHaveLength(0);
  act(() => tree!.unmount());
  keyboard.height.value = 0;
});
