import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('tamagui', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(),
);
vi.mock('lucide-react-native', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts(),
);
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/buzz/ChoiceVideoPreview', () => ({ ChoiceVideoPreview: vi.fn(() => null) }));
vi.mock('@/components/buzz/Ledger', () => ({
  LedgerUntaggedHint: vi.fn(() => null),
  LedgerEntry: vi.fn(() => null),
  LedgerGhostLine: vi.fn(() => null),
  LedgerSystemLine: vi.fn(() => null),
  LedgerSteer: vi.fn(() => null),
}));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: vi.fn(() => null) }));
vi.mock('@/components/buzz/LifecycleCard', () => ({
  GitHubEventCard: vi.fn(() => null),
  DaemonFactCard: vi.fn(() => null),
}));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({
  NotificationLifecycleCard: vi.fn(() => null),
}));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnSettledLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopMessageAction', () => ({
  DesktopMessageAction: 'DesktopMessageAction',
}));
vi.mock('@/components/buzz/ButtonRow', async () => {
  const R = await import('react');
  return {
    ButtonRowFrame: R.forwardRef((props: any, _ref) =>
      R.createElement('ButtonRowFrame', null, props.children),
    ),
  };
});
vi.mock('@/components/buzz/DesktopWorkspacePortal', () => ({
  DesktopWorkspacePortal: vi.fn(() => null),
}));
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactMedia', () => ({ ArtifactImage: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptReference', () => ({
  TranscriptReference: vi.fn(() => null),
}));
vi.mock('@/components/buzz/ComputerSession', () => ({
  openComputerSessionViewer: vi.fn(() => null),
}));
vi.mock('@/components/buzz/ArtifactCard', () => ({
  ArtifactCard: vi.fn(() => null),
  openArtifactViewer: vi.fn(() => null),
}));
vi.mock('@/components/buzz/ArtifactViewer', () => ({ ArtifactViewerScreen: vi.fn(() => null) }));
vi.mock('@/components/buzz/IndexRow', () => ({
  ContentTarget: vi.fn((props: any) => React.createElement('Pressable', props, props.children)),
}));
vi.mock('@/components/buzz/AgentApprovalCard', () => ({
  AgentApprovalCard: vi.fn(() => null),
  approvalAudience: vi.fn(() => null),
  approvalDecisionNote: vi.fn(() => null),
}));
vi.mock('@/components/buzz/ActivityTimeline', () => ({
  ActivityTimeline: vi.fn(() => null),
  TurnStepsLine: vi.fn(() => null),
}));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/MessageReactionRoster', () => ({
  MessageReactionRoster: vi.fn(() => null),
}));
vi.mock('@/components/buzz/Button', () => ({ Button: vi.fn(() => null) }));
vi.mock('@/components/buzz/MonoHull', () => ({
  NewMessageMaterialize: vi.fn(() => null),
  PixelLoader: vi.fn(() => null),
}));
vi.mock('@/modal', () => ({ Modal: vi.fn(() => null) }));
vi.mock('@/buzz/picture-actions', () => ({ showPictureActions: vi.fn(() => null) }));
vi.mock('@/buzz/chat-attachment', () => ({ formatAttachmentSize: vi.fn(() => null) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(() => null) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelOnboarding: vi.fn(() => null) }));
vi.mock('@/buzz/artifact-viewport', () => ({ useArtifactRowVisible: vi.fn(() => null) }));
vi.mock('@/buzz/live-draft-drain', () => ({ liveDraftDrainStore: vi.fn(() => null) }));
vi.mock('@/buzz/viewer-conversation', () => ({
  currentViewerConversation: vi.fn(() => null),
  subscribeViewerConversation: vi.fn(() => null),
  viewerContextLabel: vi.fn(() => null),
  splitViewerContext: vi.fn(() => null),
}));
vi.mock('@/buzz/draft-settle', () => ({
  draftRequestId: vi.fn(() => null),
  provisionalDraftKey: vi.fn(() => null),
  rememberProvisionalDraft: vi.fn(() => null),
  takeProvisionalDraft: vi.fn(() => null),
}));
vi.mock('@/buzz/use-transcript-stamp', () => ({ useTranscriptStamp: vi.fn(() => null) }));
// Keep the card boundary small while exercising the production choice plates.
vi.mock('@/components/buzz/TranscriptCard', () => ({ TranscriptCard: 'TranscriptCard' }));

// Draw both swipe panels; the test opens them as a drag does.
vi.mock('@/components/buzz/TranscriptSwipeable', () => ({ default: () => null }));
import { SwipeToReply } from './RoomMessageVariants-attachment-card';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it('DESKTOP-MESSAGE-ACTIONS-1: the desktop toolbar adds New thread and More, which opens the phone sheet', () => {
  const onActions = vi.fn();
  const onSwipeThread = vi.fn();
  let renderer: any;
  act(() => {
    renderer = create(
      <SwipeToReply
        messageId="m1"
        isDesktop
        onLongPress={vi.fn()}
        onReact={vi.fn()}
        onForward={vi.fn()}
        onReply={vi.fn()}
        onReportIssue={vi.fn()}
        onActions={onActions}
        onSwipeThread={onSwipeThread}
      >
        <></>
      </SwipeToReply>,
    );
  });
  const actions = () => renderer.root.findAllByType('DesktopMessageAction');
  expect(actions().map((node: any) => node.props.action)).toEqual([
    'copy',
    'reply',
    'react',
    'report',
    'forward',
    'thread',
    'more',
  ]);
  const action = (name: string) => actions().find((node: any) => node.props.action === name);
  expect(action('thread').props.tooltip).toBe('New thread');
  act(() => action('thread').props.onPress());
  expect(onSwipeThread).toHaveBeenCalledOnce();
  act(() => action('more').props.onPress());
  expect(onActions).toHaveBeenCalledOnce();

  // A row with no thread or sheet offers neither.
  act(() => {
    renderer.update(
      <SwipeToReply
        messageId="m1"
        isDesktop
        onLongPress={vi.fn()}
        onReact={vi.fn()}
        onForward={vi.fn()}
      >
        <></>
      </SwipeToReply>,
    );
  });
  expect(actions().map((node: any) => node.props.action)).toEqual(['copy', 'react', 'forward']);
  act(() => renderer.unmount());
});
