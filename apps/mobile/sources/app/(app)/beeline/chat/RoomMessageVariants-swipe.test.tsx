import React from 'react';
import { Text } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, I18nManager: { isRTL: false }, Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/ChoiceVideoPreview', () => ({ ChoiceVideoPreview: vi.fn(() => null) }));
vi.mock('@/components/buzz/Ledger', () => ({ LedgerUntaggedHint: vi.fn(() => null), LedgerEntry: vi.fn(() => null), LedgerGhostLine: vi.fn(() => null), LedgerSystemLine: vi.fn(() => null), LedgerSteer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: vi.fn(() => null) }));
vi.mock('@/components/buzz/LifecycleCard', () => ({ GitHubEventCard: vi.fn(() => null), DaemonFactCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({ NotificationLifecycleCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnSettledLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopMessageAction', () => ({ DesktopMessageAction: vi.fn(() => null) }));
vi.mock('@/components/buzz/ButtonRow', () => ({ ButtonRowFrame: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopWorkspacePortal', () => ({ DesktopWorkspacePortal: vi.fn(() => null) }));
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactMedia', () => ({ ArtifactImage: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptReference', () => ({ TranscriptReference: vi.fn(() => null) }));
vi.mock('@/components/buzz/ComputerSession', () => ({ openComputerSessionViewer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactCard', () => ({ ArtifactCard: vi.fn(() => null), openArtifactViewer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactViewer', () => ({ ArtifactViewerScreen: vi.fn(() => null) }));
vi.mock('@/components/buzz/IndexRow', () => ({ ContentTarget: vi.fn((props: any) => React.createElement('Pressable', props, props.children)) }));
vi.mock('@/components/buzz/AgentApprovalCard', () => ({ AgentApprovalCard: vi.fn(() => null), approvalAudience: vi.fn(() => null), approvalDecisionNote: vi.fn(() => null) }));
vi.mock('@/components/buzz/ActivityTimeline', () => ({ ActivityTimeline: vi.fn(() => null), TurnStepsLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/MessageReactionRoster', () => ({ MessageReactionRoster: vi.fn(() => null) }));
vi.mock('@/components/buzz/Button', () => ({ Button: vi.fn(() => null) }));
vi.mock('@/components/buzz/MonoHull', () => ({ NewMessageMaterialize: vi.fn(() => null), PixelLoader: vi.fn(() => null) }));
vi.mock('@/modal', () => ({ Modal: vi.fn(() => null) }));
vi.mock('@/buzz/picture-actions', () => ({ showPictureActions: vi.fn(() => null) }));
vi.mock('@/buzz/chat-attachment', () => ({ attachmentOpenUrl: vi.fn(() => null), formatAttachmentSize: vi.fn(() => null) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(() => null) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelOnboarding: vi.fn(() => null) }));
vi.mock('@/buzz/artifact-viewport', () => ({ useArtifactRowVisible: vi.fn(() => null) }));
vi.mock('@/buzz/live-draft-drain', () => ({ liveDraftDrainStore: vi.fn(() => null) }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: vi.fn(() => null), subscribeViewerConversation: vi.fn(() => null), viewerContextLabel: vi.fn(() => null), splitViewerContext: vi.fn(() => null) }));
vi.mock('@/buzz/draft-settle', () => ({ draftRequestId: vi.fn(() => null), provisionalDraftKey: vi.fn(() => null), rememberProvisionalDraft: vi.fn(() => null), takeProvisionalDraft: vi.fn(() => null) }));
vi.mock('@/buzz/use-transcript-stamp', () => ({ useTranscriptStamp: vi.fn(() => null) }));
// Keep the card boundary small while exercising the production choice plates.
vi.mock('@/components/buzz/TranscriptCard', () => ({ TranscriptCard: 'TranscriptCard' }));

// Draw both swipe panels; the test opens them as a drag does.
const swipe = vi.hoisted(() => ({ props: null as any }));
vi.mock('@/components/buzz/TranscriptSwipeable', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: any) => {
      swipe.props = props;
      return createElement('Swipeable', null, props.actionsVisible ? props.renderLeftActions?.() : null, props.children, props.actionsVisible ? props.renderRightActions?.() : null);
    },
  };
});
import { SwipeToReply } from './RoomMessageVariants-attachment-card';

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });

it('draws reply and new thread as grammar swipe actions, with no corner wording', () => {
  let renderer: any;
  act(() => {
    renderer = create(
      <SwipeToReply messageId="m1" isDesktop={false} onLongPress={vi.fn()} onReact={vi.fn()} onForward={vi.fn()}
        onReply={vi.fn()} onSwipeThread={vi.fn()}>
        <></>
      </SwipeToReply>,
    );
  });
  const panel = (id: string) => renderer.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
  const label = (id: string) => panel(id).findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children).flat().join('');
  expect(renderer.root.findAll((node: any) => typeof node.type === 'string' &&
    ['thread-swipe-action-m1', 'reply-swipe-action-m1'].includes(node.props.testID))).toHaveLength(0);
  expect(swipe.props.actionsVisible).toBe(false);
  act(() => swipe.props.onSwipeableOpenStartDrag());
  expect(swipe.props.actionsVisible).toBe(true);
  expect(panel('thread-swipe-action-m1').props.accessibilityLabel).toBe('Open a new thread from this message');
  expect(label('thread-swipe-action-m1')).toBe('New thread');
  expect(label('reply-swipe-action-m1')).toBe('Reply');
  // Glyph and name share one line, so a one-line message row does not clip the name.
  for (const id of ['thread-swipe-action-m1', 'reply-swipe-action-m1']) {
    expect(panel(id).type).toBe('XStack');
    expect(panel(id).props.width).toBeUndefined();
  }
  expect(JSON.stringify(renderer.toJSON())).not.toMatch(/\bcorner\b/i);
  act(() => swipe.props.onSwipeableClose());
  expect(swipe.props.actionsVisible).toBe(false);
  expect(renderer.root.findAll((node: any) => typeof node.type === 'string' &&
    ['thread-swipe-action-m1', 'reply-swipe-action-m1'].includes(node.props.testID))).toHaveLength(0);
  act(() => renderer.unmount());
});

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector',
  Gesture: { Pan: () => {
    const pan: Record<string, unknown> = {};
    for (const method of ['enabled', 'activeOffsetX', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
      pan[method] = () => pan;
    }
    return pan;
  } },
}));

it('leaves native action layers unmounted while the message is at rest', async () => {
  const { default: NativeSwipeable } = await vi.importActual<typeof import('@/components/buzz/TranscriptSwipeable')>('@/components/buzz/TranscriptSwipeable');
  const left = vi.fn(() => <Text>New thread</Text>);
  const right = vi.fn(() => <Text>Reply</Text>);
  const props = { renderLeftActions: left, renderRightActions: right };
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<NativeSwipeable {...props} actionsVisible={false}><Text>Message</Text></NativeSwipeable>); });
  expect(left).not.toHaveBeenCalled();
  expect(right).not.toHaveBeenCalled();
  act(() => renderer.update(<NativeSwipeable {...props} actionsVisible><Text>Message</Text></NativeSwipeable>));
  expect(left).toHaveBeenCalledOnce();
  expect(right).toHaveBeenCalledOnce();
  act(() => renderer.update(<NativeSwipeable {...props} actionsVisible={false}><Text>Message</Text></NativeSwipeable>));
  expect(renderer.root.findAll((node: any) => node.type === Text).map((node: any) => node.props.children)).toEqual(['Message']);
  act(() => renderer.unmount());
});
