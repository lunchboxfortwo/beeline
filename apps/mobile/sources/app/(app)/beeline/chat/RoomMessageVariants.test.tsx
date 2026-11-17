import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChoiceCardView } from '@beeline/api-contract/phone';
import type { AttachmentReference } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { TranscriptCardChoicePlate } from '@/components/buzz/ChoicePlate';

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/ChoiceVideoPreview', () => ({ ChoiceVideoPreview: vi.fn(() => null) }));
vi.mock('@/components/buzz/Ledger', () => ({ LedgerUntaggedHint: vi.fn(() => null), LedgerEntry: vi.fn(() => null), LedgerGhostLine: vi.fn(() => null), LedgerSystemLine: vi.fn(() => null), LedgerRoomUpdate: vi.fn(() => null), LedgerSteer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: vi.fn(() => null) }));
vi.mock('@/components/buzz/LifecycleCard', () => ({ GitHubEventCard: vi.fn(() => null), DaemonFactCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({ NotificationLifecycleCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptSwipeable', () => ({ default: vi.fn((props: any) => props.children) }));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnSettledLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopMessageAction', () => ({ DesktopMessageAction: vi.fn(() => null) }));
vi.mock('@/components/buzz/ButtonRow', () => ({ ButtonRowFrame: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopWorkspacePortal', () => ({ DesktopWorkspacePortal: vi.fn(() => null) }));
vi.mock('@/components/buzz/AppMark', () => ({ AppMark: vi.fn(() => null) }));
vi.mock('@/components/buzz/ArtifactMedia', () => ({ ArtifactImage: vi.fn(() => null) }));
vi.mock('@/components/buzz/ComputerSession', () => ({ openComputerSessionViewer: vi.fn(() => null), ComputerSessionCard: vi.fn(() => null) }));
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
vi.mock('@/buzz/chat-list-store', () => ({ readChatList: vi.fn() }));
vi.mock('@/buzz/room-message-records', () => ({ roomMessageRecord: vi.fn(), writeRoomBookmark: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), phoneOperationFailureReason: vi.fn() }));
vi.mock('@/buzz/message-forward', async importOriginal => ({ ...await importOriginal<typeof import('@/buzz/message-forward')>(), forwardMessageToRoom: vi.fn(), forwardTargets: vi.fn(), resolveForwardTargetRoom: vi.fn() }));

vi.mock('@/buzz/picture-actions', () => ({ showPictureActions: vi.fn(() => null) }));
vi.mock('@/buzz/chat-attachment', () => ({ formatAttachmentSize: vi.fn(() => null) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn(() => null) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelOnboarding: vi.fn(() => null) }));
vi.mock('@/buzz/artifact-viewport', () => ({ useArtifactRowVisible: vi.fn(() => null) }));
vi.mock('@/buzz/live-draft-drain', () => ({ liveDraftDrainStore: vi.fn(() => null) }));
vi.mock('@/buzz/viewer-conversation', () => ({ currentViewerConversation: vi.fn(() => null), subscribeViewerConversation: vi.fn(() => null), viewerContextLabel: vi.fn(() => null), splitViewerContext: vi.fn(() => null) }));
vi.mock('@/buzz/draft-settle', () => ({ draftRequestId: vi.fn(() => null), provisionalDraftKey: vi.fn(() => null), rememberProvisionalDraft: vi.fn(() => null), takeProvisionalDraft: vi.fn(() => null) }));
vi.mock('@/buzz/use-transcript-stamp', () => ({ useTranscriptStamp: vi.fn(() => null) }));
// Keep the card boundary small while exercising the production choice plates.
vi.mock('@/components/buzz/TranscriptCard', () => ({
  TranscriptCard: (props: any) => React.createElement('TranscriptCard', props,
    React.createElement('Text', { testID: props.footerNoteTestID }, props.footerNote),
    props.media,
    ...(props.choices ?? []).map((choice: any) => React.createElement(TranscriptCardChoicePlate, {
      key: choice.id, choice, closed: props.tier === 'record',
    }))),
  TranscriptCardHandle: 'Text',
}));

import { ChoiceCard } from './RoomMessageVariants';
import { OrdinaryLedgerMessage } from './RoomMessageVariants-ordinary-ledger-message';
import { ArtifactCard } from '@/components/buzz/ArtifactCard';
import { LedgerEntry, LedgerSteer } from '@/components/buzz/Ledger';
import { NewMessageMaterialize } from '@/components/buzz/MonoHull';
import { TurnSettledLine } from '@/components/buzz/TurnProgressLine';
import { splitViewerContext } from '@/buzz/viewer-conversation';
import TranscriptSwipeable from '@/components/buzz/TranscriptSwipeable';
import { useChatMessageActions } from './useChatMessageActions';
import { readRoomViewMessage } from '@beeline/api-contract/phone';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { useChatTranscriptRenderer } from './useChatTranscriptRenderer';

vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: vi.fn() }));
vi.mock('@/components/buzz/VaultSaveCard', () => ({ VaultSaveCard: () => null }));
vi.mock('@/components/buzz/AgentSignInCard', () => ({ AgentSignInCard: () => null }));
vi.mock('./RepositoryOnboardingCard', () => ({ RepositoryOnboardingCard: () => null }));
vi.mock('@/components/buzz/CornerOpenedMarker', () => ({ CornerOpenedMarkers: () => null }));
vi.mock('@/components/buzz/TranscriptPills', () => ({ TranscriptPills: () => null }));
vi.mock('@/components/buzz/GrantRequestCard', () => ({
  GrantRequestCard: vi.fn(() => null), canDecideGrantRequest: () => false,
  GrantRequestPill: ({ card }: any) => card,
}));
vi.mock('./chat-surface-values', () => ({
  knownAgentPubkeysFor: () => new Set(), rosterAgent: () => undefined, durableFactLine: () => '',
}));
vi.mock('@/buzz/room-message-cell', () => ({
  messageFailureGroups: () => new Map(), archiveActionPresentation: () => ({}),
  liveCardPresentation: () => ({}), messageRosterPresentation: () => ({}),
  useRoomMessageRenderItem: ({ render, presentationForMessage }: any) => ({ item }: any) =>
    render(item, presentationForMessage(item)),
}));
const VIEWER = 'a'.repeat(64);
/** Synthetic regression fixture matching a legacy hash-derived choice ID and three images. */
const syntheticImageChoice = {
  "id": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "room_id": "66666666-6666-4666-8666-666666666666",
  "author_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "text": "Three sample JPEGs attached.\n\n**A**: First sample #SampleOne\n**B**: Second sample #SampleTwo\n**C**: Third sample #SampleThree\n\n@sample.person choose A, B or C.",
  "presentation": "card",
  "card_type": "choice",
  "card": {
    "ask": "Which sample should we choose?",
    "mode": "question",
    "agent": {
      "face": "owl",
      "kind": "agent",
      "name": "Sample Artist",
      "handle": "sample.artist",
      "pubkey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "route": {
      "to": {
        "agent": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "place": "66666666-6666-4666-8666-666666666666"
      },
      "from": {
        "agent": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "place": "66666666-6666-4666-8666-666666666666"
      }
    },
    "prompt": "Which sample should we choose?",
    "status": "open",
    "options": [
      {
        "label": "A",
        "letter": "A",
        "optionId": "A",
        "consequence": "A"
      },
      {
        "label": "B",
        "letter": "B",
        "optionId": "B",
        "consequence": "B"
      },
      {
        "label": "C",
        "letter": "C",
        "optionId": "C",
        "consequence": "C"
      }
    ],
    "choiceId": "12345678-1234-4123-e123-123456789abc",
    "requester": {
      "face": "fox",
      "kind": "human",
      "name": "Sample Person",
      "avatar": "https://example.invalid/avatar/person.jpg",
      "handle": "sample.person",
      "pubkey": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "responses": [],
    "electorate": [
      "1111111111111111111111111111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222222222222222222222222222",
      "3333333333333333333333333333333333333333333333333333333333333333",
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "4444444444444444444444444444444444444444444444444444444444444444"
    ],
    "votedCount": 0,
    "sourceRoomId": "66666666-6666-4666-8666-666666666666",
    "electorateCount": 5
  },
  "attachments": [
    {
      "url": "https://example.invalid/v1/media/00000001-1111-4111-8111-000000000001",
      "name": "Sample A.jpg",
      "size": 111111,
      "mimeType": "image/jpeg"
    },
    {
      "url": "https://example.invalid/v1/media/00000002-1111-4111-8111-000000000002",
      "name": "Sample B.jpg",
      "size": 222222,
      "mimeType": "image/jpeg"
    },
    {
      "url": "https://example.invalid/v1/media/00000003-1111-4111-8111-000000000003",
      "name": "Sample C.jpg",
      "size": 333333,
      "mimeType": "image/jpeg"
    }
  ],
  "created_at": "2025-01-02 03:04:05.12345+00"
};

it.each([
  { name: 'three images and a high legacy variant', images: true, card: {}, fallback: false },
  { name: 'no attachments and a low legacy variant', images: false,
    card: { choiceId: 'abcdef01-2345-4678-1234-56789abcdef0' }, fallback: false },
  { name: 'answered choice after an open-card update', images: false, card: {
    status: 'answered', selectedOptionId: 'A', footer: 'picked A · @sample.person',
    answeredBy: { pubkey: 'c'.repeat(64), kind: 'human', name: 'Sample Person',
      handle: 'sample.person', face: 'whale', avatar: '/v1/person-avatars/77777777-7777-4777-8777-777777777777' },
    electorate: ['2'.repeat(64), 'c'.repeat(64)], electorateCount: 2, votedCount: 1,
    responses: [{ optionId: 'A', identityId: 'c'.repeat(64) }], requester: undefined,
  }, fallback: false },
  { name: 'skipped choice', images: false, card: { status: 'skipped' }, fallback: false },
  { name: 'closed choice', images: false, card: { status: 'closed' }, fallback: false },
  { name: 'rejected choice ID', images: true, card: { choiceId: 'invalid-choice' }, fallback: true },
  { name: 'rejected options', images: false, card: { options: [] }, fallback: true },
  { name: 'rejected mode', images: false, card: { mode: 'unknown' }, fallback: true },
  { name: 'rejected status', images: false, card: { status: 'unknown' }, fallback: true },
  { name: 'rejected counts', images: false, card: { votedCount: 'unknown' }, fallback: true },
])('renders a synthetic choice with $name and starts a swipe reply', scenario => {
  const stored = {
    ...syntheticImageChoice,
    card: { ...syntheticImageChoice.card, ...scenario.card },
    attachments: scenario.images ? syntheticImageChoice.attachments : [],
  };
  const dto = readRoomViewMessage({
    id: stored.id, text: stored.text, presentation: stored.presentation,
    createdAt: Math.floor(Date.parse(stored.created_at) / 1000),
    author: stored.card.agent, choice: stored.card, attachments: stored.attachments,
    reference: { channelId: stored.room_id, eventId: stored.id, rootId: stored.id },
  })!;
  const row = displayRoomMessage(dto, VIEWER);
  const installReply = vi.fn();
  const prefill = vi.fn();
  const focus = vi.fn();
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
  function Fixture({ messageRow = row }: { messageRow?: ChatDisplayMessage }) {
    const inputs: unknown[] = Array.from({ length: 34 }, () => vi.fn());
    Object.assign(inputs, {
      0: new Map(), 1: new Map(), 2: { current: [messageRow] }, 3: stored.room_id,
      4: installReply, 5: prefill, 6: { current: '' }, 7: { current: null },
      10: { current: { focus } },
    });
    const [, , beginReply] = useChatMessageActions(inputs as Parameters<typeof useChatMessageActions>[0]);
    const args: unknown[] = Array(69).fill(undefined);
    Object.assign(args, {
      0: false, 4: null, 10: new Map(), 11: new Map(), 12: new Map(),
      13: [], 14: stored.room_id, 15: VIEWER, 17: {}, 20: false,
      21: onAnswer, 22: onSkip, 42: beginReply, 52: false,
      53: new Set(), 54: new Set(), 55: new Set(),
      56: { states: new Map(), retry: vi.fn() }, 57: {}, 58: new Map(), 63: [messageRow],
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: messageRow });
  }
  if (row.choice?.status === 'answered') {
    const open = displayRoomMessage({ ...dto, choice: {
      ...row.choice, status: 'open', responses: [], footer: undefined,
      selectedOptionId: undefined, answeredBy: undefined,
    } }, VIEWER);
    act(() => { renderer = create(<Fixture messageRow={open} />); });
    expect(cardProps().tier).toBe('ask');
    act(() => renderer.update(<Fixture messageRow={row} />));
    expect(cardProps().tier).toBe('record');
    expect(cardProps().footerNote).toBe('A · picked A · @sample.person');
  } else {
    act(() => { renderer = create(<Fixture />); });
  }
  if (scenario.fallback) {
    expect(row.choice).toBeUndefined();
    expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
  } else {
    expect(row.choice?.choiceId).toBe(stored.card.choiceId);
    expect(cardProps().testID).toBe(`choice-${stored.card.choiceId}`);
    expect(cardProps().title).toBe(stored.card.prompt);
    expect(cardProps().choices.map((option: any) => option.id)).toEqual(
      stored.card.status === 'open' ? ['A', 'B', 'C'] : []);
    expect(renderer.root.findAllByType(ArtifactCard).map((node: any) => node.props.attachment))
      .toEqual(stored.attachments);
  }
  const swipe = vi.mocked(TranscriptSwipeable).mock.calls.at(-1)?.[0];
  expect(swipe?.enabled).toBe(true);
  act(() => { swipe!.onSwipeableWillOpen!('left'); while (frames.length) frames.shift()!(); });
  expect(installReply).toHaveBeenCalledWith(expect.objectContaining({
    messageId: stored.id, authorPubkey: stored.author_id, authorHandle: 'sample.artist', isAgent: true,
    reference: { channelId: stored.room_id, eventId: stored.id, rootId: stored.id },
  }));
  expect(prefill).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fill', text: '@sample.artist ' }),
    { handle: 'sample.artist', pubkey: stored.author_id });
  expect(focus).toHaveBeenCalledOnce();
  expect(onAnswer).not.toHaveBeenCalled();
  expect(onSkip).not.toHaveBeenCalled();
});
it.each([
  { kind: 'attachment', allowed: true },
  { kind: 'card', allowed: true },
  { kind: 'card', allowed: false, desktop: true },
  { kind: 'card', allowed: false, announcement: true },
  { kind: 'card', allowed: false, draft: true },
  { kind: 'card', allowed: false, noReference: true },
])('shares reply eligibility with the composer for $kind rows ($allowed, $desktop, $announcement, $draft, $noReference)', scenario => {
  const roomId = syntheticImageChoice.room_id;
  const row: ChatDisplayMessage = {
    id: 'c'.repeat(64), text: '', timestamp: 1, isUser: false,
    attachments: syntheticImageChoice.attachments,
    ...(!scenario.noReference ? { reference: { channelId: roomId, eventId: 'c'.repeat(64), rootId: 'c'.repeat(64) } } : {}),
    ...(scenario.draft ? { isAgentDraft: true } : {}),
    ...(scenario.kind === 'card' ? { vaultSave: {
      service: 'example', label: 'Example', purpose: 'Connect', fields: [],
      allowedHosts: [], authStrategy: 'api_key' as const, agentId: 'b'.repeat(64),
      ownerId: VIEWER, ownerName: 'Owner', status: 'pending' as const,
    } } : {}),
  };
  const beginReply = vi.fn();
  function Fixture() {
    const args: unknown[] = Array(69).fill(undefined);
    Object.assign(args, {
      0: false, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: roomId, 15: VIEWER, 17: {}, 20: !!scenario.desktop, 36: !!scenario.announcement,
      42: beginReply, 52: !!scenario.desktop, 53: new Set(), 54: new Set(), 55: new Set(),
      56: { states: new Map(), retry: vi.fn() }, 57: {}, 58: new Map(), 63: [row],
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: row });
  }
  act(() => { renderer = create(<Fixture />); });
  const swipes = vi.mocked(TranscriptSwipeable).mock.calls.map(call => call[0]);
  expect(swipes).toHaveLength(scenario.allowed ? 1 : 0);
  if (scenario.allowed) {
    expect(swipes[0].enabled).toBe(true);
    act(() => swipes[0].onSwipeableWillOpen!('left'));
    expect(beginReply).toHaveBeenCalledExactlyOnceWith(row);
  }
});

const choice: ChoiceCardView = {
  choiceId: '11111111-1111-4111-8111-111111111111', mode: 'question', status: 'open',
  agent: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Beebee', handle: 'beebee' },
  prompt: 'Every agent on a step stopped; a person chooses to retry or end.',
  constraint: 'No answer in 24 h applies abandon',
  closesAt: 1793786400,
  options: [
    { optionId: 'A', letter: 'A', label: 'retry', consequence: 'Retry this step' },
    { optionId: 'B', letter: 'B', label: 'abandon', consequence: 'End this run' },
  ], electorate: [VIEWER], responses: [], votedCount: 0, electorateCount: 1,
};
const message: ChatDisplayMessage = { id: 'message', text: '', isUser: false, timestamp: 1793700000, choice };
const cardRendererCases: Array<{ name: string; patch: Record<string, unknown> }> = [
  { name: 'vault save', patch: { vaultSave: { agentId: 'b'.repeat(64) } } },
  { name: 'room update', patch: { roomUpdate: { digest: 'synthetic-update' } } },
  { name: 'permission approval', patch: { writePermission: { agentPubkey: 'b'.repeat(64), status: 'pending' } } },
  { name: 'grant approval', patch: { grantRequest: { agent: syntheticImageChoice.card.agent } } },
  { name: 'Squire approval', patch: { squireApproval: {
    agent: syntheticImageChoice.card.agent, detail: 'Synthetic approval', tool: 'operate_login',
  } } },
  { name: 'computer session', patch: { computerSession: { title: 'Synthetic browser' } } },
  { name: 'onboarding', patch: { onboarding: { title: 'Synthetic onboarding' } } },
  { name: 'choice', patch: { choice } },
  { name: 'app sign-in', patch: { appSignIn: {
    agentId: 'b'.repeat(64), ownerId: VIEWER, name: 'Sample App', appKey: 'sample', appId: 'sample',
  } } },
  { name: 'agent sign-in', patch: { agentSignIn: { agentId: 'b'.repeat(64), ownerId: VIEWER } } },
  { name: 'connector offer', patch: { connectorOffer: {
    agent: syntheticImageChoice.card.agent, status: 'pending', connectorType: 'sample',
    addressee: syntheticImageChoice.card.requester, offerId: 'synthetic-offer',
  } } },
  { name: 'notification lifecycle', patch: { notificationLifecycleRun: {} } },
  { name: 'wallet transaction', patch: { walletTx: { direction: 'out', amountText: '$1' } } },
  { name: 'wallet insufficient', patch: { walletInsufficient: { needed: '1', asset: 'USD', chain: 'sample' } } },
  { name: 'wallet delegation', patch: { walletDelegation: { standing: true } } },
  { name: 'target branch approval', patch: { targetBranchProposal: { proposalId: 'synthetic-proposal', from: 'main', to: 'sample' } } },
  { name: 'GitHub event', patch: { githubEvent: {} } },
  { name: 'daemon fact', patch: { daemonFact: {} } },
  { name: 'workflow handoff', patch: { isSystemNotice: true, systemEvent: { kind: 'workflow-handoff' } } },
  { name: 'ended voice call', patch: { isSystemNotice: true, voiceCall: { endedAt: 1 } } },
  { name: 'durable fact', patch: { durableFact: { kind: 'action' } } },
  { name: 'unknown future card', patch: {} },
];

it.each(cardRendererCases)('wraps the $name renderer once and replies to that card message', ({ patch }) => {
  const source = syntheticImageChoice;
  // Renderer payloads stop at mocked media/approval boundaries; all row identity
  // and parent-reference facts pass through the real phone/display projection.
  const dto = readRoomViewMessage({
    id: source.id, text: 'Synthetic card', createdAt: 1, presentation: 'card',
    author: source.card.agent,
    reference: { channelId: source.room_id, eventId: source.id, rootId: source.id },
  })!;
  const row = { ...displayRoomMessage(dto, VIEWER), ...patch } as ChatDisplayMessage;
  const installReply = vi.fn();
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
  function Fixture() {
    const inputs: unknown[] = Array.from({ length: 34 }, () => vi.fn());
    Object.assign(inputs, {
      0: new Map(), 1: new Map(), 2: { current: [row] }, 3: source.room_id,
      4: installReply, 5: vi.fn(), 6: { current: '' }, 7: { current: null },
      10: { current: { focus: vi.fn() } },
    });
    const [, , beginReply] = useChatMessageActions(inputs as Parameters<typeof useChatMessageActions>[0]);
    const args: unknown[] = Array(69).fill(undefined);
    Object.assign(args, {
      0: false, 4: null, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: source.room_id, 15: VIEWER, 17: {}, 20: false, 21: onAnswer, 22: onSkip,
      42: beginReply, 52: false, 53: new Set(), 54: new Set(), 55: new Set(),
      56: { states: new Map(), retry: vi.fn() }, 57: {}, 58: new Map(), 63: [row],
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: row });
  }
  act(() => { renderer = create(<Fixture />); });
  const swipes = vi.mocked(TranscriptSwipeable).mock.calls.map(call => call[0]);
  expect(swipes).toHaveLength(1);
  expect(swipes[0].enabled).toBe(true);
  act(() => { swipes[0].onSwipeableWillOpen!('left'); while (frames.length) frames.shift()!(); });
  expect(installReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    messageId: source.id,
    reference: { channelId: source.room_id, eventId: source.id, rootId: source.id },
  }));
  expect(onAnswer).not.toHaveBeenCalled();
  expect(onSkip).not.toHaveBeenCalled();
});
let renderer: ReactTestRenderer;
const onAnswer = vi.fn();
const onSkip = vi.fn();
function element(card: ChoiceCardView, actionId: string | null = null) {
  return <ChoiceCard message={{ ...message, choice: card }} viewerIsAgent={false}
    viewerPubkey={VIEWER} actionId={actionId} onAnswer={onAnswer} onSkip={onSkip} />;
}
function cardProps() { return renderer.root.findByType('TranscriptCard').props; }
function plates() { return renderer.root.findAllByType(TranscriptCardChoicePlate); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.mocked(splitViewerContext).mockImplementation(text => ({ body: text }));
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.unstubAllGlobals(); });

it('renders a workflow-closed question as a record without dead option boxes', () => {
  act(() => { renderer = create(element({ ...choice, status: 'closed', runId: 'run' })); });
  expect(cardProps().tier).toBe('record');
  expect(cardProps().footerNote).toBe('Closed · no longer waiting for an answer');
  expect(plates()).toHaveLength(0);
  expect(cardProps().actions).toEqual([]);
  expect(cardProps().noteInput).toBeUndefined();
  expect(cardProps().subline).toBeUndefined();
  expect(cardProps().wrapTitle).toBe(true);
});

it('shows the selected outcome and actor after an answer, without option boxes', () => {
  act(() => { renderer = create(element({ ...choice, status: 'answered', selectedOptionId: 'B',
    answeredBy: { pubkey: VIEWER, kind: 'human', name: 'Alex Chen', handle: 'alex.chen' },
    footer: 'picked B · @alex.chen', responses: [{ identityId: VIEWER, optionId: 'B' }],
  })); });
  expect(cardProps().footerNote).toBe('abandon · picked B · @alex.chen');
  expect(plates()).toHaveLength(0);
});

it('keeps the answer readable when an older answered card has no saved footer', () => {
  act(() => { renderer = create(element({ ...choice, status: 'answered', selectedOptionId: 'A',
    answeredBy: { pubkey: VIEWER, kind: 'human', name: 'Alex Chen', handle: 'alex.chen' },
  })); });
  expect(cardProps().footerNote).toBe('retry · picked A · @alex.chen');
  expect(plates()).toHaveLength(0);
});

it.each(['expired · no answer', 'skipped · @alex.chen'])('shows the settled footer %s without options', (footer) => {
  act(() => { renderer = create(element({ ...choice, status: 'skipped', footer })); });
  expect(cardProps().footerNote).toBe(footer);
  expect(plates()).toHaveLength(0);
});

/** The tappable choice plates (host nodes that carry the press). */
const choicePlates = () => renderer.root.findAll((node: any) =>
  typeof node.type === 'string' && node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function');

it('answers an open question on tap, then removes controls when its closed DTO arrives', () => {
  act(() => { renderer = create(element({ ...choice, runId: 'run' })); });
  const buttons = choicePlates();
  expect(buttons).toHaveLength(2);
  act(() => buttons[1].props.onPress());
  expect(onAnswer).toHaveBeenCalledWith(choice.choiceId, 'B');
  expect(cardProps().noteInput).toBeDefined();
  expect(cardProps().subline).toContain('No answer in 24 h applies abandon');
  expect(cardProps().actions[0].label).toBe('Skip');
  act(() => renderer.update(element({ ...choice, status: 'closed', runId: 'run' })));
  expect(choicePlates()).toHaveLength(0);
  expect(cardProps().noteInput).toBeUndefined();
});

it('answers an open poll on tap', () => {
  act(() => { renderer = create(element({ ...choice, mode: 'poll' })); });
  act(() => choicePlates()[0].props.onPress());
  expect(onAnswer).toHaveBeenCalledWith(choice.choiceId, 'A');
});

it('keeps closed poll result plates and their vote counts', () => {
  act(() => { renderer = create(element({ ...choice, mode: 'poll', status: 'closed',
    footer: '1 of 1 voted', options: choice.options.map((option) => ({ ...option, votes: option.optionId === 'B' ? 1 : 0 })),
  })); });
  expect(plates()).toHaveLength(2);
  expect(plates()[1].props.choice.votes).toBe(1);
  expect(choicePlates()).toHaveLength(0);
});

function ordinaryProps(): React.ComponentProps<typeof OrdinaryLedgerMessage> {
  vi.mocked(NewMessageMaterialize).mockImplementation(({ children }: any) => children);
  vi.mocked(splitViewerContext).mockImplementation(text => ({ body: text }));
  return {
    message: { id: 'pending', text: 'Please check the market', isUser: true, pubkey: VIEWER, timestamp: 1 },
    viewerPubkey: VIEWER, personName: 'Kai', participantsHydrated: true, speakerWorking: false,
    continued: true, firstBylineOfDay: false, participantHandles: [], channelIndex: { rooms: [], corners: [] },
    deliveryFailed: false, onChannelReference() {}, onReply() {}, onCopy() {}, onDismiss() {},
  };
}

it('SEND-PENDING greys only pending text, then restores committed text without a glyph or status line', () => {
  const props = ordinaryProps();
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} sendState={{ kind: 'sending', text: 'Sending' }} />); });
  expect(vi.mocked(LedgerSteer).mock.calls.at(-1)?.[0].pending).toBe(true);
  expect(TurnSettledLine).not.toHaveBeenCalled();
  act(() => renderer.update(<OrdinaryLedgerMessage {...props} />));
  expect(vi.mocked(LedgerSteer).mock.calls.at(-1)?.[0].pending).toBe(false);
  expect(TurnSettledLine).not.toHaveBeenCalled();
});

it.each([
  { kind: 'offline' as const, text: 'Not sent' },
  { kind: 'refused' as const, text: 'Not sent: Room access denied', reason: 'Room access denied' },
])('SEND-FAILED puts $text under the message with one Retry action', sendState => {
  const props = ordinaryProps(), retry = vi.fn();
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} sendState={sendState} sendFailureIds={['pending']} onRetry={retry} />); });
  const line = vi.mocked(TurnSettledLine).mock.calls.at(-1)![0];
  expect(line).toMatchObject({ line: sendState.text, inset: false, leadingGlyph: false, multiline: true, action: { label: 'Retry' } });
  line.action!.onPress(); expect(retry).toHaveBeenCalledWith(['pending']);
  expect(vi.mocked(LedgerSteer).mock.calls.at(-1)?.[0].pending).toBe(true);
});

it('SEND-GROUP emits only the last failure line and retries the exact consecutive group', () => {
  const props = ordinaryProps(), retry = vi.fn(), sendState = { kind: 'offline' as const, text: 'Not sent' };
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} sendState={sendState} onRetry={retry} />); });
  expect(TurnSettledLine).not.toHaveBeenCalled();
  act(() => renderer.update(<OrdinaryLedgerMessage {...props} sendState={sendState} sendFailureIds={['a', 'b', 'pending']} onRetry={retry} />));
  const line = vi.mocked(TurnSettledLine).mock.calls.at(-1)![0];
  expect(line.line).toBe('3 not sent'); expect(line.action!.label).toBe('Retry all');
  line.action!.onPress(); expect(retry).toHaveBeenCalledWith(['a', 'b', 'pending']);
});

it('SEND-ACTIONS keeps tap and long press on the existing message-actions path', () => {
  const props = ordinaryProps(), actions = vi.fn();
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} sendState={{ kind: 'offline', text: 'Not sent' }} onMessageActions={actions} />); });
  const target = renderer.root.findByProps({ testID: 'copy-message-pending' });
  act(() => target.props.onPress()); act(() => target.props.onLongPress());
  expect(actions).toHaveBeenCalledTimes(2); expect(actions).toHaveBeenCalledWith(props.message);
});

// Reproduction the owner reported: the same posted file grew and shrank between
// the artifact card and the file pill because the shape read an optional server
// decoration. The file's own data decides the shape, so both reads agree.
const postedFile: AttachmentReference = {
  url: '/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'shot.png',
  mimeType: 'image/png',
  size: 1024,
};

// The row builds the attachment elements once and hands the same array to
// whichever frame paints the message, so the element type is the shape.
function postedAttachmentElement(): any {
  const steer = vi.mocked(LedgerSteer).mock.calls.at(-1)?.[0] as any;
  const entry = vi.mocked(LedgerEntry).mock.calls.at(-1)?.[0] as any;
  const attachments = (steer ?? entry)?.attachments;
  return Array.isArray(attachments) ? attachments[0] : undefined;
}

it('ONE-SHAPE renders the artifact card for a posted file with or without server decoration', () => {
  const props = ordinaryProps();
  const decorated: AttachmentReference = { ...postedFile, kind: 'artifact', title: 'Mock', author: 'ruby' };
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} message={{ ...props.message, attachments: [decorated] }} />); });
  expect(postedAttachmentElement()?.type).toBe(ArtifactCard);
  act(() => renderer.update(<OrdinaryLedgerMessage {...props} message={{ ...props.message, attachments: [postedFile] }} />));
  expect(postedAttachmentElement()?.type).toBe(ArtifactCard);
  act(() => renderer.update(<OrdinaryLedgerMessage {...props} message={{ ...props.message, attachmentUploadPending: true, attachments: [postedFile] }} />));
  expect(postedAttachmentElement()?.type).toBe(ArtifactCard);
  expect(postedAttachmentElement()?.props.visible).toBe(false);
});

it.each([false, true])('QUOTE-CLAMP: the original stays within two lines while the full reply body reaches the ledger (desktop=%s)', desktopLayout => {
  const props = ordinaryProps();
  const original = Array.from({ length: 8 }, (_, i) => `Original paragraph ${i + 1}. ${'Long quoted text. '.repeat(20)}`).join('\n\n');
  const reply = Array.from({ length: 8 }, (_, i) => `Reply paragraph ${i + 1}. ${'Full reply text. '.repeat(20)}`).join('\n\n');
  vi.mocked(LedgerSteer).mockImplementation((ledger: any) => React.createElement('LedgerSteer', ledger, ledger.replyReference));
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} desktopLayout={desktopLayout}
    message={{ ...props.message, text: reply, replyToId: 'original' }}
    referencedTarget={{ messageId: 'original', authorName: 'Ruby', isAgent: true, preview: original }} />); });
  const quote = renderer.root.findByType('Text');
  expect(quote.props.numberOfLines).toBe(2);
  expect(quote.props.children).toContain(original);
  expect(renderer.root.findByType('LedgerSteer').props.bodyText).toBe(reply);
});
