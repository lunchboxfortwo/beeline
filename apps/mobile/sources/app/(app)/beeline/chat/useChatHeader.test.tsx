import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('tamagui', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(),
);
vi.mock('lucide-react-native', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts(),
);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));

import { EmptyLedgerState } from '@/components/buzz/EmptyLedgerState';
import { useChatHeader } from './useChatHeader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each([0, 1])(
  'shows no empty-chat copy until the roster resolves with %s agents',
  async (agentCount) => {
    const connect = vi.fn();
    function Chat({ loaded, roster }: { loaded: boolean; roster: boolean }) {
      const ref = React.useRef<any>(null);
      const draft = React.useRef('');
      const mentions = React.useRef(new Map<string, string>());
      const surface = loaded
        ? { members: [], messages: [], viewer: { permissions: { send: true } } }
        : null;
      const workspace = roster
        ? { agents: Array.from({ length: agentCount }, () => ({})), workspace: { name: 'Team' } }
        : null;
      const [variant, , , , , focus, prompts, intro] = useChatHeader([
        undefined,
        surface as any,
        'general',
        false,
        'room',
        'room-id',
        false,
        'viewer',
        null,
        new Map(),
        null,
        new Map(),
        0,
        workspace as any,
        false,
        ref,
        draft,
        mentions,
        mentions,
        () => {},
        () => {},
        'workspace',
        false,
        connect,
        true,
        () => {},
        () => {},
        () => {},
        () => {},
      ], React.useRef<string | null>(null));
      return (
        <EmptyLedgerState
          variant={variant}
          onPress={focus}
          starterPrompts={prompts}
          starterIntro={intro}
        />
      );
    }
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Chat loaded={false} roster={false} />);
    });
    expect(tree.toJSON()).toBeNull();
    await act(async () => {
      tree.update(<Chat loaded roster={false} />);
    });
    expect(tree.toJSON()).toBeNull();
    await act(async () => {
      tree.update(<Chat loaded roster />);
    });
    const text = tree.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children)
      .flat()
      .join(' ');
    expect(text).toContain('This chat is empty');
    expect(text).toContain(agentCount === 0 ? 'Connect an agent' : 'Add an agent');
    expect(text).not.toContain('Nothing in the log yet');
    if (agentCount === 0) {
      await act(async () =>
        tree.root
          .findAll(
            (node: any) =>
              node.props.testID === 'starter-connect-agent' &&
              typeof node.props.onPress === 'function',
          )[0]
          .props.onPress(),
      );
      expect(connect).toHaveBeenCalledWith(true);
    }
    await act(async () => tree.unmount());
  },
);

it.each([
  ['starter-ask-agent', '@ruby Help me turn this idea into a plan: '],
  ['starter-open-corner', '@ruby Open a thread to '],
])('records %s only when its fill succeeds', (testID, expected) => {
  const draft = { current: '' };
  const insertedStarterRef = { current: null as string | null };
  const setText = vi.fn();
  const setSelection = vi.fn();
  function Header() {
    const [, , , , , , prompts] = useChatHeader([
      undefined,
      { members: [{ identity: { kind: 'agent', handle: 'ruby', pubkey: 'agent-1' } }],
        viewer: { permissions: { send: true } } } as any,
      'general', false, 'room', 'room-id', false, 'viewer', null, new Map(), null,
      new Map(), 0,
      { agents: [{}], workspace: { name: 'Team' } } as any,
      false, { current: null }, draft, { current: new Map() }, { current: new Map() },
      setText, setSelection, 'workspace', false, vi.fn(), true,
      vi.fn(), vi.fn(), vi.fn(), vi.fn(),
    ], insertedStarterRef);
    return <EmptyLedgerState variant="room" starterPrompts={prompts} onPress={() => {}} />;
  }
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(<Header />); });
  const press = () => tree.root.findAll((node: any) =>
    node.props.testID === testID && typeof node.props.onPress === 'function')[0].props.onPress();
  try {
    act(press);
    expect(draft.current).toBe(expected);
    expect(setText).toHaveBeenLastCalledWith(expected);
    expect(insertedStarterRef.current).toBe(expected);
    expect(setSelection).toHaveBeenLastCalledWith({ start: expected.length, end: expected.length });
    draft.current = 'my own draft';
    insertedStarterRef.current = null;
    setText.mockClear();
    act(press);
    expect(draft.current).toBe('my own draft');
    expect(setText).not.toHaveBeenCalled();
    expect(insertedStarterRef.current).toBeNull();
  } finally {
    act(() => tree.unmount());
  }
});
