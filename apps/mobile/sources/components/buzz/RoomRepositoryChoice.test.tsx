import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Keyboard: { dismiss: vi.fn() },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
  VirtualizedList: ({ data, getItem, getItemCount, renderItem, initialNumToRender = 10, ...props }: any) =>
    React.createElement('VirtualizedList', props,
      Array.from({ length: Math.min(getItemCount(data), initialNumToRender) }, (_, index) => {
        const item = getItem(data, index);
        return React.createElement(React.Fragment, { key: item.key }, renderItem({ item, index }));
      })),
}));
vi.mock('@/buzz/use-text-draft', () => ({ useTextDraft: (_: string, initial: string) => React.useState(initial) }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./HullDialog', () => ({ HullDialogActions: 'Actions', HullDialogInput: 'Input' }));
vi.mock('./RepositoryMark', () => ({ RepositoryMark: 'RepositoryMark' }));
vi.mock('./HullActionSheet', async () => {
  const R = await import('react');
  return {
    HULL_SHEET_INSET: 16,
    HullActionSheetRow: 'Row',
    HullActionSheetModal: (p: any) =>
      R.createElement(
        'Sheet',
        p,
        p.visible ? R.createElement(R.Fragment, null, p.sticky, p.children, p.footer) : null,
      ),
  };
});
vi.mock('./RepositoryChoice', () => ({
  RepositoryChoice: 'RepositoryChoice',
  repositoryChoiceFacts: () => ({
    activeInstallations: [],
    selectedInstallation: null,
    nameMatch: null,
    takenRepo: null,
    githubConnected: false,
  }),
  splitFullName: () => ({ name: 'test' }),
  useSelectConnectedOwner: () => (f: unknown) => f,
}));
import { useRoomRepositoryChoice, RoomActionsSheet } from './RoomRepositoryChoice';
let renderer: ReactTestRenderer;
beforeEach(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});
it('owns open/close renders and resets the repository draft on reopening', () => {
  const renders = vi.fn();
  const buildContent = vi.fn();
  const ref = React.createRef<{ setVisible: (v: boolean) => void }>();
  const nativeProps = vi.fn();
  const backgroundRef = { current: { setNativeProps: nativeProps } };
  const onLoad = vi.fn();
  const repository = {
    canManage: true,
    roomName: 'proof',
    current: null,
    candidates: Array.from({ length: 1000 }, (_, index) => ({ key: `repo-${index}`, name: `owner/repository-${index}` })),
    installations: [],
    loading: false,
    busy: false,
    error: null,
    notice: null,
    listOpen: false,
    setListOpen: vi.fn(),
    onLoad,
    onConnect: vi.fn(),
    onLink: vi.fn(),
    onCreate: vi.fn(),
    onUnlink: vi.fn(),
    onCancel: () => ref.current?.setVisible(false),
    draftContext: 'proof',
  };
  function Host({ label }: { label: string }) {
    renders();
    return (
      <RoomActionsSheet
        ref={ref}
        backgroundRef={backgroundRef as any}
        repository={repository}
        onClose={() => ref.current?.setVisible(false)}
        title="proof"
      >
        {() => { buildContent(label); return <TextFixture label={label} />; }}
      </RoomActionsSheet>
    );
  }
  function TextFixture({ label }: { label: string }) {
    return React.createElement('Text', {}, label);
  }
  act(() => {
    renderer = create(<Host label="first" />);
  });
  expect(renders).toHaveBeenCalledOnce();
  expect(buildContent).not.toHaveBeenCalled();
  act(() => ref.current!.setVisible(true));
  expect(buildContent).toHaveBeenCalledWith('first');
  expect(renders).toHaveBeenCalledOnce();
  expect(renderer.root.findByType('Text').props.children).toBe('first');
  expect(nativeProps).toHaveBeenCalledWith({ importantForAccessibility: 'no-hide-descendants' });
  act(() => renderer.root.findByProps({ testID: 'room-repo-row' }).props.onPress());
  expect(onLoad).toHaveBeenCalledOnce();
  expect(renderer.root.findAllByType('RepositoryChoice')).toHaveLength(1);
  // Reproduction CHAT-REPO-1: opening the list used to update the entire chat,
  // then mount its virtualized rows inside the sheet's ScrollView.
  act(() => renderer.root.findByType('RepositoryChoice').props.onOpenList());
  expect(repository.setListOpen).not.toHaveBeenCalled();
  expect(renderer.root.findByType('Sheet').props.title).toBe('Choose a repo');
  expect(renderer.root.findByType('Sheet').props.scrollBody).toBe(false);
  expect(renderer.root.findAllByType('VirtualizedList')).toHaveLength(1);
  const rows = () => renderer.root.findAll((node: any) => node.type === 'Row' && node.props.testID?.startsWith('room-repo-list-candidate-'));
  expect(rows()).toHaveLength(6);
  act(() => renderer.root.findByType('Input').props.onChangeText('repository-999'));
  expect(rows()).toHaveLength(1);
  expect(rows()[0].props.accessibilityLabel).toBe('owner/repository-999');
  act(() => rows()[0].props.onPress());
  expect(renderer.root.findAllByType('VirtualizedList')).toHaveLength(0);
  act(() => renderer.root.findByType('RepositoryChoice').props.onOpenList());
  expect(renders).toHaveBeenCalledOnce();
  act(() => renderer.root.findByType('Sheet').props.onClose());
  expect(renderer.root.findByType('Sheet').props.visible).toBe(true);
  expect(renderer.root.findAllByType('RepositoryChoice')).toHaveLength(1);
  act(() => ref.current!.setVisible(false));
  act(() => {
    renderer.update(<Host label="latest" />);
  });
  act(() => ref.current!.setVisible(true));
  expect(renders).toHaveBeenCalledTimes(2);
  expect(renderer.root.findByType('Text').props.children).toBe('latest');
  expect(renderer.root.findAllByType('RepositoryChoice')).toHaveLength(0);
  act(() => renderer.root.findByType('Sheet').props.onClose());
  expect(renderer.root.findByType('Sheet').props.visible).toBe(false);
  expect(renders).toHaveBeenCalledTimes(2);
  expect(nativeProps).toHaveBeenLastCalledWith({ importantForAccessibility: 'auto' });
});


it('CHAT-REPO-1: presents Repository before the chat-owned loading render', () => {
  const commits: string[] = [];
  function Choice({ onLoad }: { onLoad: () => void }) {
    const choice = useRoomRepositoryChoice({
      visible: true, canManage: true, roomName: 'proof', current: null,
      candidates: [], installations: [], loading: false, busy: false,
      error: null, notice: null, listOpen: false, setListOpen: vi.fn(),
      onLoad, onConnect: vi.fn(), onLink: vi.fn(), onCreate: vi.fn(),
      onUnlink: vi.fn(), onCancel: vi.fn(), draftContext: 'priority-proof',
    });
    React.useLayoutEffect(() => { if (choice.control) commits.push('presented'); });
    return <>{choice.row}{choice.control}</>;
  }
  function Chat() {
    const [loading, setLoading] = React.useState(false);
    if (loading) commits.push('chat-loading');
    return <Choice onLoad={() => setLoading(true)} />;
  }
  act(() => { renderer = create(<Chat />); });
  commits.length = 0;
  act(() => renderer.root.findByProps({ testID: 'room-repo-row' }).props.onPress());
  expect(commits[0]).toBe('presented');
  expect(commits).toContain('chat-loading');
});
