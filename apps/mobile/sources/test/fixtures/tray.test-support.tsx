import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, vi } from 'vitest';
import type { WorkBoardView, WorkItemView } from '@beeline/api-contract/phone';
import TrayScreen from '@/app/(app)/beeline/tray';
vi.mock('@/buzz/use-relative-time-refresh', () => ({ useRelativeTimeRefresh: () => undefined }));
vi.mock('tamagui', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(),
);
vi.mock('lucide-react-native', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts(),
);
vi.mock('@/ui/grammar', async () => {
  const { createElement } = await import('react');
  return {
    T: (p: any) => createElement('Text', p, p.children),
    Copy: (p: any) => createElement('Text', p, p.children),
    Glyph: (p: any) => createElement('Glyph', p),
    Btn: (p: any) => createElement('Button', { 'aria-label': p.label, ...p }, p.children),
    HEIGHT: { control: 44 },
    SheetScroll: (p: any) => createElement('ScrollView', p, p.children),
    SheetFrame: (p: any) =>
      p.open ? createElement('Sheet', { testID: p.testID, title: p.title }, p.children) : null,
  };
});
vi.mock('@/components/buzz/IdentityMark', () => ({
  IdentityMark: (p: any) => React.createElement('Avatar', p),
}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({
  SurfaceGlyphLoader: () => React.createElement('Loader'),
}));
const state = vi.hoisted(() => ({
  board: null as WorkBoardView | null,
  desktop: false,
  workspace: 'ws',
  push: vi.fn(),
  operation: vi.fn(async () => undefined),
  reply: vi.fn(async () => true),
  load: vi.fn(async () => undefined),
}));
export { state };
vi.mock('@/buzz/work-board-reply', () => ({ sendWorkReply: state.reply }));
vi.mock('@/buzz/work-board-store', () => ({
  useWorkBoard: () => state.board,
  useWorkBoardUnavailable: () => false,
  loadWorkBoard: state.load,
}));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => state.desktop }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => state.workspace }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/buzz/corner-navigation', () => ({
  messageJumpHref: (roomId: string, messageId: string) => ({ roomId, messageId }),
  navigateToRoom: (_router: unknown, roomId: string) => state.push({ roomId }),
}));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchPushRoom: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: state.operation }));
vi.mock('@/buzz/app-error-copy', () => ({ appErrorCopy: (e: Error) => e.message }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ communityId: 'ws' }),
  useRouter: () => ({ push: state.push }),
}));
vi.mock('@/ui/shell/TabHeader', () => ({
  TabHeader: (p: any) => React.createElement('Header', p, p.actions),
  TabRail: (p: any) => React.createElement('Rail', p, p.children),
  useScrolledUnder: () => ({ scrolled: false }),
}));
export const human = { pubkey: 'person', kind: 'human' as const, name: 'Ada' };
export const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Jellybean' };
export function task(p: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id: 'thread',
    roomId: 'thread',
    chatId: 'chat',
    chatName: 'beeline',
    threadName: 'latency-coverage',
    title: 'Measure phone reply latency',
    state: 'in-progress',
    openedBy: human,
    assignee: agent,
    createdAt: 1,
    updatedAt: 2,
    ...p,
  };
}
export function ask(p: Partial<WorkItemView> = {}): WorkItemView {
  return task({
    id: 'ask',
    state: 'needs-you',
    assignee: human,
    messageId: 'ask',
    ask: {
      messageId: 'ask',
      workspaceId: 'ws',
      roomId: 'thread',
      roomName: 'latency-coverage',
      parentRoomName: 'beeline',
      roomKind: 'corner',
      createdAt: 1,
      text: 'Which surface should Jellybean measure next?',
      author: agent,
    },
    ...p,
  });
}
export function serve(items: WorkItemView[]) {
  state.board = {
    workspaceId: 'ws',
    workspaceName: 'Tubing Crew',
    viewerId: 'person',
    items,
    chats: [
      { id: 'chat', name: 'beeline' },
      { id: 'milo', name: 'Milo' },
    ],
    people: [agent, human],
  };
}
const mounted: ReactTestRenderer[] = [];
export async function renderTags() {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TrayScreen />);
  });
  mounted.push(tree);
  return tree;
}
export function byLabel(tree: ReactTestRenderer, label: string) {
  return tree.root.find((n: any) => typeof n.type === 'string' && n.props['aria-label'] === label);
}
export async function press(tree: ReactTestRenderer, label: string) {
  await act(async () => {
    await byLabel(tree, label).props.onPress({ stopPropagation() {} });
  });
}
export function textOf(tree: ReactTestRenderer) {
  return tree.root
    .findAll((n: any) => n.type === 'Text')
    .flatMap((n: any) => [n.props.children].flat(Infinity))
    .filter((v: unknown) => typeof v === 'string' || typeof v === 'number')
    .join(' ');
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.desktop = false;
  state.board = null;
  state.reply.mockReset();
  state.reply.mockResolvedValue(true);
  state.operation.mockReset();
  state.operation.mockResolvedValue(undefined);
  state.load.mockClear();
  state.push.mockClear();
});
afterEach(async () => {
  for (const tree of mounted.splice(0)) await act(async () => tree.unmount());
});
export { act };
