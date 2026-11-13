import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

import TrayScreen from '../../app/(app)/beeline/tray';
import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { resetClientState } from '@/sync/client-reset';

/**
 * Tags (`/beeline/tray`) under test: Tamagui and lucide render as named hosts
 * (`ui/screens/transcript/grammar-hosts.test-support.ts`), phone operations
 * are answered by name, and the live socket is a set of listeners the test
 * drives. The needs-you store under it is the real one.
 */

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());

vi.mock('@/buzz/router-chat-list', () => ({
  acquireRoutedChatList: (_key: unknown, _consumer: unknown, legacy: () => unknown) => legacy(),
}));

const layout = vi.hoisted(() => ({ desktop: false }));
export { layout };
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => layout.desktop }));

const appState = vi.hoisted(() => ({ current: 'active' }));
export { appState };

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    AppState: {
      get currentState() {
        return appState.current;
      },
      addEventListener: () => ({ remove: () => undefined }),
    },
    // Every item is painted and viewable, as a short list on a phone is.
    FlatList: (props: any) => {
      ReactModule.useEffect(() => {
        props.onViewableItemsChanged?.({
          viewableItems: (props.data ?? []).map((item: unknown) => ({ item, isViewable: true })),
        });
      }, [props.data]);
      return ReactModule.createElement(
        'FlatList',
        props,
        (props.data ?? []).length ? null : props.ListEmptyComponent,
        ...(props.data ?? []).map((item: any, index: number) =>
          ReactModule.createElement(ReactModule.Fragment, { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index }))),
      );
    },
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
export { navigation };

const route = vi.hoisted(() => ({
  params: { communityId: 'ws', workspaceName: 'Beeline Work' } as { communityId?: string; workspaceName?: string },
}));
export { route };

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => route.params,
  useRouter: () => navigation,
  router: navigation,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));
export { auth };
vi.mock('@/auth/buzz-identity-storage', () => auth);

const workspaceSet = vi.hoisted(() => ({ active: null as string | null }));
export { workspaceSet };
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => workspaceSet.active),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    void Promise.resolve(workspaceSet.active).then(listener);
    return () => undefined;
  }),
}));

vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: (_relay: string, _viewer: string, endpoint: string) => endpoint,
  mobileSurfaceCache: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}));

const phoneOperation = vi.hoisted(() => vi.fn());
export { phoneOperation };
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: phoneOperation,
  readServerSurface: (_authority: unknown, ...args: unknown[]) => phoneOperation(...args),
}));

const liveRegistrations = vi.hoisted(() => new Set<(event: unknown) => void>());
export { liveRegistrations };
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, listener: (event: unknown) => void) => {
      liveRegistrations.add(listener);
      return () => liveRegistrations.delete(listener);
    },
  }),
}));

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
export { openExternal };
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: openExternal }));

const prefetchRoom = vi.hoisted(() => vi.fn());
export { prefetchRoom };
vi.mock('@/push/push-room-prefetch', () => ({ prefetchPushRoom: prefetchRoom }));

const viewer = vi.hoisted(() => ({ open: vi.fn() }));
export { viewer };
vi.mock('@/components/buzz/ArtifactCard', () => ({ openArtifactViewer: viewer.open }));
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: vi.fn(async () => ({ uri: 'blob:shot' })),
  releaseArtifactImageSource: vi.fn(),
}));

vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return { SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props) };
});

export const person = { pubkey: 'person-1', kind: 'human' as const, name: 'Maya', handle: 'maya' };

/** One Needs-you cell as the server projects it. */
export function need(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'ask-1',
    workspaceId: 'ws',
    roomId: 'room-1',
    roomName: 'paperband',
    roomKind: 'room' as const,
    text: '@Dan, can you check the snapshot labels?',
    createdAt: 1_700_000_000,
    author: person,
    ...overrides,
  };
}

/** The server: reads see `server.needs`; decisions are recorded and answered. */
export function serve(server: { needs: unknown[]; refuse?: string }) {
  phoneOperation.mockImplementation(async (name: string, input: { messageId?: string; messageIds?: string[] }) => {
    if (name === 'readTray') return { needs: { items: server.needs }, saved: { bookmarks: [] } };
    if (name === 'readNeedsYou') return { items: server.needs };
    if (name === 'countNeedsYou') return { count: server.needs.length };
    // The server starts each painted question's 24-hour clock once.
    if (name === 'markNeedsYouSeen')
      return { seen: (input.messageIds ?? []).map((messageId) => ({ messageId, expiresAt: 1_700_086_400 })) };
    if (server.refuse === name) throw new Error('refused');
    if (name === 'clearNeedsYou')
      server.needs = server.needs.filter((item: any) => item.messageId !== input.messageId);
    return undefined;
  });
  return server;
}

export const calls = (name: string) => phoneOperation.mock.calls.filter(([called]) => called === name);

export function deliver(delta: unknown) {
  for (const listener of [...liveRegistrations]) listener({ monolithLive: delta });
}

/** Text drawn by `T` hosts, flattened. */
export function textOf(tree: ReactTestRenderer): string {
  return tree.root
    .findAll((node: any) => node.type === 'Text')
    .flatMap((node: any) => [node.props.children].flat(Infinity))
    .filter((part: unknown) => typeof part === 'string')
    .join(' ')
    .replace(/\s+/g, ' ');
}

export const byTestId = (tree: ReactTestRenderer, testID: string) =>
  tree.root.find((node: any) => node.props.testID === testID && typeof node.type === 'string');
export const hasTestId = (tree: ReactTestRenderer, testID: string) =>
  tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string').length > 0;

export async function press(tree: ReactTestRenderer, testID: string) {
  await act(async () => {
    await byTestId(tree, testID).props.onPress?.({ stopPropagation() {} });
  });
  await act(async () => undefined);
}

/** The Tags count a list or sidebar paints beside an optionally mounted Tags screen. */
function BadgeAndTags({ tags }: { tags: boolean }) {
  const count = useNeedsYouCount('ws', 1);
  return (
    <>
      {React.createElement('Badge', { testID: 'badge', count })}
      {tags ? <TrayScreen /> : null}
    </>
  );
}
export const badge = (tree: ReactTestRenderer) => byTestId(tree, 'badge').props.count as number;

const mounted: ReactTestRenderer[] = [];

export async function renderTags(withBadge = false): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(withBadge ? <BadgeAndTags tags /> : <TrayScreen />);
  });
  mounted.push(tree);
  await act(async () => undefined);
  await act(async () => undefined);
  return tree;
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  liveRegistrations.clear();
  resetClientState();
  auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'viewer' }));
  layout.desktop = false;
  appState.current = 'active';
  navigation.back.mockReset();
  navigation.push.mockReset();
  navigation.replace.mockReset();
  route.params = { communityId: 'ws', workspaceName: 'Beeline Work' };
  workspaceSet.active = null;
  phoneOperation.mockReset();
  openExternal.mockClear();
  prefetchRoom.mockReset();
  viewer.open.mockReset();
  serve({ needs: [] });
});

afterEach(async () => {
  for (const tree of mounted.splice(0)) await act(async () => tree.unmount());
});
