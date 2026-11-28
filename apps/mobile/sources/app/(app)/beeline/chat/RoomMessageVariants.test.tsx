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
vi.mock('@/components/buzz/Ledger', () => ({ LedgerEntryFrame: ({ children }: any) => children, LedgerUntaggedHint: vi.fn(() => null), LedgerEntry: vi.fn(() => null), LedgerGhostLine: vi.fn(() => null), LedgerSystemLine: vi.fn(() => null), LedgerRoomUpdate: vi.fn(() => null), LedgerSteer: vi.fn(() => null) }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ ErrorBanner: vi.fn(() => null) }));
vi.mock('@/components/buzz/LifecycleCard', () => ({ GitHubEventCard: vi.fn(() => null), DaemonFactCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/PrLifecycleCard', () => ({ NotificationLifecycleCard: vi.fn(() => null) }));
vi.mock('@/components/buzz/TranscriptSwipeable', () => ({ default: vi.fn((props: any) => props.children) }));
vi.mock('@/components/buzz/TurnProgressLine', () => ({ TurnSettledLine: vi.fn(() => null) }));
vi.mock('@/components/buzz/DesktopMessageAction', () => ({ DesktopMessageAction: (props: any) => React.createElement('DesktopMessageAction', props) }));
vi.mock('@/components/buzz/ButtonRow', () => ({ ButtonRowFrame: ({ children }: any) => children }));
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
vi.mock('@/buzz/room-message-records', () => ({ roomMessageRecord: vi.fn() }));
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

import { ChoiceCard, SwipeToReply } from './RoomMessageVariants';
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
import { foldTranscriptRows } from '@/buzz/room-message-store';

vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: vi.fn() }));
vi.mock('@/components/buzz/VaultSaveCard', () => ({ VaultSaveCard: () => null }));
vi.mock('@/components/buzz/AgentSignInCard', () => ({ AgentSignInCard: () => null }));
vi.mock('./RepositoryOnboardingCard', () => ({ RepositoryOnboardingCard: () => null }));
vi.mock('@/components/buzz/TranscriptPills', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/buzz/TranscriptPills')>(), TranscriptPills: () => null,
}));
vi.mock('@/components/buzz/GrantRequestCard', () => ({ GrantRequestCard: vi.fn(() => null) }));
vi.mock('./chat-surface-values', () => ({
  knownAgentPubkeysFor: () => new Set(), rosterAgent: () => undefined, durableFactLine: () => '',
}));
vi.mock('@/buzz/room-message-cell', async importOriginal => ({
  messageFailureGroups: () => new Map(),
  archiveActionPresentation: (await importOriginal<typeof import('@/buzz/room-message-cell')>()).archiveActionPresentation,
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
  ordinaryProps();
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
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 4: null, 10: new Map(), 11: new Map(), 12: new Map(),
      13: [], 14: stored.room_id, 15: VIEWER, 17: {}, 20: false,
      21: onAnswer, 41: beginReply, 50: false,
      51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: [messageRow],
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
    expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
    act(() => renderer.update(<Fixture messageRow={row} />));
    expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
  } else {
    act(() => { renderer = create(<Fixture />); });
  }
  if (scenario.fallback) {
    expect(row.choice).toBeUndefined();
    expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
  } else {
    expect(row.choice?.choiceId).toBe(stored.card.choiceId);
    expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
    expect(plates()).toHaveLength(0);
    expect(vi.mocked(LedgerEntry).mock.calls.at(-1)?.[0]).toMatchObject({
      bodyText: `${stored.text}\n\n${stored.card.prompt}`,
      byline: expect.objectContaining({ name: stored.card.agent.name }),
    });
    expect(React.Children.toArray(vi.mocked(LedgerEntry).mock.calls.at(-1)?.[0].attachments)
      .flatMap((node: any) => node.props.groupAttachments ?? [node.props.attachment]))
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
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: roomId, 15: VIEWER, 17: {}, 20: !!scenario.desktop, 35: !!scenario.announcement,
      41: beginReply, 50: !!scenario.desktop, 51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: [row],
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
    { optionId: 'A', letter: 'A', label: 'retry' },
    { optionId: 'B', letter: 'B', label: 'abandon' },
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
  { name: 'poll', patch: { choice: { ...choice, mode: 'poll' } } },
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
  { name: 'failed workflow handoff', patch: { isSystemNotice: true, workflowRunEnd: 'failed', systemEvent: { kind: 'workflow-handoff' } } },
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
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 4: null, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: source.room_id, 15: VIEWER, 17: {}, 20: false, 21: onAnswer,
      41: beginReply, 50: false, 51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: [row],
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
});
it('renders the morning workflow approval as its question and choices only', () => {
  // Reduced from the two 2026-11-18 production rows. Raw exports stay outside the repo.
  // The gate card was stored before options lost `consequence`; it still renders, without it.
  const owner = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
  const agent = {
    face: 'owl', kind: 'agent', name: 'Ruby', handle: 'ruby',
    avatar: '/v1/agent-avatars/54c083c9-76ee-47e7-a797-b8fcb4a3a8a8',
    pubkey: 'c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b',
  };
  const runId = 'af0d790d02ea49aa245270dbad8788436c1ef87d374f2aac5e75b484ab8a39d2';
  const askId = '5ec426a2bad18dfc9b2e1387428364cb76c60f6a34870e8c32ba9419caf01d19';
  const choiceId = '4d946fe7-10f6-494e-8314-8e5dfea4c182';
  const prompt = 'Owner taps approve all, replies with item numbers, or skips the card.';
  const createdAtMs = Date.parse('2026-11-18T15:27:20.072349Z');
  const source = [
    {
      id: askId, text: `@ruby asked ${prompt}`, choice: {
        choiceId, mode: 'question', status: 'open', agent, prompt, runId,
        options: [
          { label: 'approve_all', letter: 'A', optionId: 'A',
            consequence: 'Open one fix thread per same-area bundle for every actionable card item.' },
          { label: 'pick_numbers', letter: 'B', optionId: 'B',
            consequence: "Read the owner's item numbers and open fix threads for only those items." },
          { label: 'skip', letter: 'C', optionId: 'C', consequence: "The card's approvals are settled." },
        ],
        electorate: [owner], electorateCount: 1, votedCount: 0, responses: [],
      },
    },
    {
      id: runId, text: 'Ruby started workflow morning-card-2026-11-18 · run af0d790d',
      systemEvent: {
        kind: 'workflow-handoff', verb: 'started workflow',
        object: { text: 'morning-card-2026-11-18' },
        subject: { id: agent.pubkey, kind: 'agent', name: 'Ruby' },
        consequence: 'run af0d790d',
      },
    },
    // The gate's answer and a same-time handoff are routine workflow lines: hidden, never the gate card.
    {
      id: 'a'.repeat(64), text: 'lunchboxfortwo picked approve_all · at approve so run af0d790d went to fix_all',
      systemEvent: {
        kind: 'workflow-handoff', verb: 'picked', object: { text: 'approve_all' },
        subject: { id: owner, kind: 'person', name: 'lunchboxfortwo' },
        consequence: 'at approve so run af0d790d went to fix_all',
      },
    },
    {
      id: 'b'.repeat(64), text: 'Ruby handed off done · run af0d790d of morning-card-2026-11-18',
      systemEvent: {
        kind: 'workflow-handoff', verb: 'handed off', object: { text: 'done' },
        subject: { id: agent.pubkey, kind: 'agent', name: 'Ruby' },
        consequence: 'run af0d790d of morning-card-2026-11-18',
      },
    },
  ];
  const projected = source.map(row => displayRoomMessage(readRoomViewMessage({
    ...row, author: agent, presentation: 'card',
    createdAt: Math.floor(createdAtMs / 1000), createdAtMs,
  })!, owner));
  const folded = foldTranscriptRows(projected, null);
  expect(folded.rows.map(row => row.id)).toEqual([askId]);
  expect(folded.hostIds.get(askId)).toBe(askId);
  function Fixture() {
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 4: null, 10: new Map(), 11: new Map(), 12: new Map(),
      13: [], 14: syntheticImageChoice.room_id, 15: owner, 17: {}, 20: false,
      21: onAnswer, 50: false,
      51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: folded.rows,
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return <>{folded.rows.map(item => <React.Fragment key={item.id}>{render({ item })}</React.Fragment>)}</>;
  }
  act(() => { renderer = create(<Fixture />); });
  expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(1);
  expect(cardProps().title).toBe(prompt);
  expect(cardProps().tier).toBe('ask');
  // The prompt shows once: the "@ruby asked <prompt>" system text is not a second body.
  expect(cardProps().body).toBeUndefined();
  expect(plates().map((plate: { props: React.ComponentProps<typeof TranscriptCardChoicePlate> }) =>
    plate.props.choice.label)).toEqual(['Approve all', 'Pick numbers', 'Skip']);
  for (const plate of plates()) expect(plate.props.choice).not.toHaveProperty('consequence');
  expect(cardProps().noteInput).toBeUndefined();
  expect(cardProps().actions).toBeUndefined();
  expect(cardProps().subline).toBeUndefined();
  for (const plate of plates()) {
    act(() => plate.props.choice.onPress());
    expect(onAnswer).toHaveBeenLastCalledWith(choiceId, plate.props.choice.id);
  }
});

it('keeps one line when a workflow run fails or is cancelled, and hides a normal finish', () => {
  const owner = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
  const system = { pubkey: 'e'.repeat(64), kind: 'agent', name: 'System', handle: 'system' };
  const createdAtMs = Date.parse('2026-11-28T09:00:00Z');
  const line = (id: string, text: string, patch: Record<string, unknown>) => ({
    id, text, author: system, createdAt: Math.floor(createdAtMs / 1000), createdAtMs,
    systemTranscript: { origin: 'system', visibility: patch.presentation === 'system' ? 'notice' : 'card' },
    presentation: 'card', ...patch,
  });
  const failed = line('1'.repeat(64), 'Ruby handed off blocked · run 215b8d09 went to failed', {
    workflowRunEnd: 'failed',
    systemEvent: { kind: 'workflow-handoff', verb: 'handed off', subject: { kind: 'agent', name: 'Ruby' } },
  });
  // A cancellation is a closed-run record: no event kind, ended `abandoned`.
  const cancelled = line('2'.repeat(64), 'lunchboxfortwo cancelled run 215b8d09', {
    presentation: 'system', workflowRunEnd: 'abandoned',
    systemEvent: { verb: 'cancelled', subject: { kind: 'person', name: 'lunchboxfortwo' } },
  });
  const finished = line('3'.repeat(64), 'Ruby handed off done · run 215b8d09 went to done', {
    workflowRunEnd: 'done',
    systemEvent: { kind: 'workflow-handoff', verb: 'handed off', subject: { kind: 'agent', name: 'Ruby' } },
  });
  const projected = [failed, cancelled, finished].map(row => displayRoomMessage(readRoomViewMessage(row)!, owner));
  expect(projected.map(row => row.workflowRunEnd)).toEqual(['failed', 'abandoned', 'done']);
  const folded = foldTranscriptRows(projected, null);
  const shown = folded.rows.flatMap(row => [row.id, ...(row.pillRun?.map(item => item.id) ?? [])]);
  expect(shown).toContain(failed.id);
  expect(shown).toContain(cancelled.id);
  expect(shown).not.toContain(finished.id);
});

let renderer: ReactTestRenderer;
const onAnswer = vi.fn();
function element(card: ChoiceCardView, actionId: string | null = null) {
  return <ChoiceCard message={{ ...message, choice: card }} viewerIsAgent={false}
    viewerPubkey={VIEWER} actionId={actionId} onAnswer={onAnswer} />;
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
  expect(cardProps().actions).toBeUndefined();
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

it('shows an answered workflow gate as its question and the chosen label in words', () => {
  act(() => { renderer = create(element({ ...choice, runId: 'run', status: 'answered', selectedOptionId: 'A',
    options: [{ optionId: 'A', letter: 'A', label: 'approve_all' }, { optionId: 'B', letter: 'B', label: 'not_now' }],
    answeredBy: { pubkey: VIEWER, kind: 'human', name: 'Alex Chen', handle: 'alex.chen' },
    footer: 'picked A · @alex.chen', responses: [{ identityId: VIEWER, optionId: 'A' }],
  })); });
  expect(cardProps().title).toBe(choice.prompt);
  expect(cardProps().footerNote).toBe('Approve all · picked A · @alex.chen');
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
  expect(cardProps().noteInput).toBeUndefined();
  expect(cardProps().subline).toContain('No answer in 24 h applies abandon');
  expect(cardProps().actions).toBeUndefined();
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

it.each([
  { text: '', prefix: '' },
  { text: choice.prompt, prefix: '' },
  { text: 'Supporting details: https://example.invalid/launch', prefix: 'Supporting details: https://example.invalid/launch\n\n' },
])('renders the ask and supporting text once with ordinary message actions ($text)', ({ text, prefix }) => {
  const props = ordinaryProps();
  const row: ChatDisplayMessage = { ...props.message, isUser: false,
    pubkey: choice.agent.pubkey, authorIdentity: choice.agent, presentation: 'card', choice,
    text, reference: { channelId: 'room', eventId: 'ask', rootId: 'ask' },
    reactions: [{ emoji: '👍', count: 1, reacted: false, members: [] }],
  };
  const onCopy = vi.fn(), onReply = vi.fn(), onReact = vi.fn(), onMessageActions = vi.fn();
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props} message={row}
    onCopy={onCopy} onReply={onReply} onReact={onReact} onMessageActions={onMessageActions} />); });
  expect(renderer.root.findAllByType('TranscriptCard')).toHaveLength(0);
  expect(vi.mocked(LedgerEntry).mock.calls.at(-1)?.[0].bodyText).toBe(prefix + choice.prompt);
  const swipe = renderer.root.findByType(SwipeToReply).props;
  expect(vi.mocked(TranscriptSwipeable).mock.calls).toHaveLength(1);
  act(() => {
    swipe.onLongPress();
    swipe.onReply();
    swipe.onActions();
    swipe.onReact('👍');
  });
  expect(onCopy).toHaveBeenCalledWith(prefix + choice.prompt);
  expect(onReply).toHaveBeenCalledWith(row);
  expect(onMessageActions).toHaveBeenCalledWith(row);
  expect(onReact).toHaveBeenCalledWith(row, '👍');
  expect(renderer.root.findAllByProps({ testID: `reaction-chips-${row.id}` }).length).toBeGreaterThan(0);
});

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
  expect(line).toMatchObject({ line: sendState.text, inset: false, multiline: true, action: { label: 'Retry' } });
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


it('R1: a reply whose original is not loaded quotes the server preview, not "Message not loaded"', () => {
  const row: ChatDisplayMessage = {
    id: 'reply', text: 'Ship it', timestamp: 1, isUser: false, replyToId: 'original',
    replyPreview: { author: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Sample Agent', handle: 'sample.agent' }, text: 'Deploy plan ready' },
  };
  vi.mocked(LedgerSteer).mockImplementation((ledger: any) => React.createElement('LedgerSteer', ledger, ledger.replyReference));
  function Fixture() {
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: 'room', 15: VIEWER, 17: {}, 20: true, 28: true, 46: false, 47: false, 50: true,
      51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(),
      59: new Map([[row.id, row]]), 61: [row],
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: row });
  }
  act(() => { renderer = create(<Fixture />); });
  const referencedTarget = renderer.root.findAll((node: any) => node.props.referencedTarget !== undefined)[0]?.props.referencedTarget;
  expect(referencedTarget).toEqual({
    messageId: 'original', authorName: 'Sample Agent', authorHandle: 'sample.agent',
    authorPubkey: 'b'.repeat(64), isAgent: true, preview: 'Deploy plan ready',
  });
  const props = ordinaryProps();
  act(() => { renderer = create(<OrdinaryLedgerMessage {...props}
    message={{ ...props.message, text: row.text, replyToId: 'original' }} referencedTarget={referencedTarget} />); });
  const quote = renderer.root.findByType('Text').props.children.flat().join('');
  expect(quote).toContain('Sample Agent');
  expect(quote).toContain('Deploy plan ready');
  expect(quote).not.toContain('Message not loaded');
});


it('removes desktop New thread when an ordinary message Room is archived', () => {
  const row: ChatDisplayMessage = { id: 'message', text: 'Start here', timestamp: 1, isUser: false };
  const forward = vi.fn();
  function Fixture({ archived }: { archived: boolean }) {
    const args: unknown[] = Array(68).fill(undefined);
    Object.assign(args, {
      0: false, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
      14: 'room', 15: VIEWER, 17: { handleForwardToNewCorner: forward },
      20: true, 28: true, 46: false, 47: archived, 50: true,
      51: new Set(), 52: new Set(), 53: new Set(),
      54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: [row],
    });
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: row });
  }
  act(() => { renderer = create(<Fixture archived={false} />); });
  act(() => renderer.root.findByProps({ testID: 'thread-button-message' }).props.onPress());
  expect(forward).toHaveBeenCalledWith(row);
  act(() => { renderer.update(<Fixture archived />); });
  expect(renderer.root.findAllByProps({ testID: 'thread-button-message' })).toHaveLength(0);
  act(() => { renderer.update(<Fixture archived={false} />); });
  act(() => renderer.root.findByProps({ testID: 'thread-button-message' }).props.onPress());
  expect(forward).toHaveBeenCalledTimes(2);
});
