import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { readRoomViewMessage, type RoomViewMessage } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('@/ui/grammar', () => ({
  T: 'Text', Copy: 'Text', TypedView: 'View', Inked: 'Pressable', Btn: 'Button', Glyph: 'Glyph',
  HEIGHT: { control: 44, row: 44 },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({ theme: { buzz: {} } }),
}));
vi.mock('./Ledger', () => ({ ledgerEntryRhythm: () => ({}), LedgerSystemLine: ({ id, text }: any) => React.createElement('Text', { testID: `system-line-${id}` }, text),
  LedgerEntryFrame: ({ children, testID }: any) => React.createElement('View', { testID }, children) }));
vi.mock('./Ledger-styles', () => ({ settledAgentProseStyle: () => ({}) }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: () => null }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/components/buzz/GitHubMark', () => ({ GitHubMark: () => null }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: () => null, CHEVRON_ROW_SIZE: 14 }));
vi.mock('./IndexRow', () => ({
  InlineRow: ({ children }: any) => <>{children}</>,
  TranscriptNavigationRow: ({ children, primary, trailing, testID }: any) => React.createElement('Pressable', {
    testID, onPress: primary?.onPress ?? trailing?.onPress,
  }, children),
}));

import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import { foldPillRuns } from '@/buzz/transcript-pills';
import { pillItems, TranscriptPills } from './TranscriptPills';
import { PillRow, runCountLabel } from '@/ui/screens/transcript/PillRow';

it.each(['message', 'reply'] as const)('renders an addressed %s with the recorded sender, recipient and text', kind => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const resolve = (id: string, name: string) => ({ kind: 'agent' as const, seed: id, name });
  const message: ChatDisplayMessage = {
    id: 'addressed', text: 'Please review the phone layout', isUser: false, timestamp: 1_800_000_000,
    pubkey: 'ruby', authorIdentity: { pubkey: 'ruby', name: 'Ruby', kind: 'agent' },
    agentCommand: { kind, recipient: { id: 'claude', name: 'Claude', handle: 'claude', kind: 'agent' },
      text: 'Please review the phone layout' },
  };
  let tree: any;
  act(() => { tree = create(<TranscriptPills run={[message]} resolve={resolve} />); });
  const [item] = tree.root.findByType(PillRow).props.items;
  expect(item).toMatchObject({ id: 'addressed', system: false,
    from: { seed: 'ruby', name: 'Ruby' }, to: { seed: 'claude', name: 'Claude' } });
  expect(item.body.props.markdown).toBe('Please review the phone layout');
  act(() => tree.unmount());
});

it('folds agent messages and stops in a row into one PillRow pill, in send order, and a system notice ends it', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const resolve = (id: string, name: string, kind?: 'agent' | 'human') => ({ kind: kind ?? 'agent', seed: id, name });
  const base = (id: string, fields: Partial<ChatDisplayMessage>): ChatDisplayMessage =>
    ({ id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields });
  const say = (id: string, from: string, to: string) => base(id, { pubkey: from, authorIdentity: { pubkey: from, name: from, kind: 'agent' },
    agentCommand: { kind: 'message', recipient: { id: to, name: to, kind: 'agent' }, text: id } });
  const stop = (id: string, by: string, kind: 'person' | 'agent', whom: string) => base(id, { isSystemNotice: true, pubkey: by,
    systemEvent: { kind: 'turn-cancelled', subject: { kind, id: by, name: by }, verb: 'stopped', object: { text: whom, id: whom } } });
  const rows = foldPillRuns([
    say('m1', 'ruby', 'claude'), stop('s1', 'ruby', 'agent', 'claude'), say('m2', 'claude', 'ruby'),
    stop('s2', 'owner', 'person', 'ruby'),
    say('m3', 'ruby', 'jelly'), say('m4', 'jelly', 'ruby'),
    base('joined', { isSystemNotice: true, text: 'Nerd joined' }),
    say('m5', 'ruby', 'nerd'),
  ]);
  expect(rows.map(row => [row.id, row.pillRun?.map(entry => entry.id) ?? null])).toEqual([
    ['m1', ['m1', 's1', 'm2', 's2', 'm3', 'm4']], ['joined', null], ['m5', null]]);
  const items = pillItems(rows[0]!.pillRun!, resolve, {});
  expect(items.map(item => [item.id, item.system, item.run?.map(entry => entry.id) ?? null])).toEqual([
    ['m1', false, ['m1', 's1', 'm2', 's2', 'm3', 'm4']]]);
  const entries = items[0]!.run!;
  expect(entries[1]).toMatchObject({ stop: true, from: { seed: 'ruby' }, to: { seed: 'claude' } });
  expect(entries[3]).toMatchObject({ stop: true, from: { kind: 'human', seed: 'owner' }, to: { seed: 'ruby' } });
  // Every opened pill reads as a run row: the heading names the recipient, so the body drops the @mention and reads quieter.
  expect(entries[0]!.body).toMatchObject({ props: { markdown: 'm1', color: 'secondary' } });
  expect(pillItems([say('m5', 'ruby', 'nerd')], resolve, {})[0]!.body).toMatchObject({ props: { markdown: 'm5', color: 'secondary' } });
  let tree: any;
  act(() => { tree = create(<TranscriptPills run={rows[0]!.pillRun!} resolve={resolve} />); });
  expect(tree.root.findByType(PillRow).props.items.map((item: any) => item.id)).toEqual(['m1']);
  act(() => tree.unmount());
});

it('folds consecutive person stops into one pill that opens in send order', () => {
  const resolve = (id: string, name: string, kind?: 'agent' | 'human') => ({ kind: kind ?? 'agent', seed: id, name });
  const base = (id: string, fields: Partial<ChatDisplayMessage>): ChatDisplayMessage =>
    ({ id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields });
  const personStop = (id: string, whom: string) => base(id, { isSystemNotice: true, pubkey: 'owner',
    systemEvent: { kind: 'turn-cancelled', subject: { kind: 'person', id: 'owner', name: 'owner' }, verb: 'stopped', object: { text: whom, id: whom } } });
  const items = pillItems([personStop('s1', 'ruby'), personStop('s2', 'claude')], resolve, {});
  expect(items.map(item => [item.id, item.system, item.run?.map(entry => entry.id) ?? null])).toEqual([
    ['s1', true, ['s1', 's2']]]);
  expect(items[0]!.run![0]).toMatchObject({ stop: true, from: { kind: 'human', seed: 'owner' }, to: { seed: 'ruby' } });
});

it('MERGE-ROWS-1 folds a run of merges into one pill that counts them and opens every stored event and destination', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const events: ChatDisplayMessage[] = Array.from({ length: 14 }, (_, index) => ({
    id: `merge-${index}`, text: `Merged change ${index}`, timestamp: 1_800_000_000 + index * 60,
    isUser: false, isSystemNotice: true,
    systemEvent: { subject: { kind: 'github', name: 'GitHub' },
      verb: 'merged pull request', object: { text: `Change ${index}`, url: `https://github.com/Beeline-Work/beeline/pull/${4200 + index}` } },
  }));
  const rows = foldPillRuns(foldPrLifecycleRuns(events));
  expect(rows).toHaveLength(1);
  const openUrl = vi.fn();
  let tree: any;
  act(() => { tree = create(<TranscriptPills run={rows[0]!.pillRun ?? [rows[0]!]}
    resolve={() => ({ kind: 'system', name: 'Beeline' })} onOpenUrl={openUrl} />); });
  // No lifecycle disclosure: the run is one pill.
  expect(tree.root.findAll((node: any) => node.props?.testID === 'notification-run-expand-merge-0')).toHaveLength(0);
  const [item] = tree.root.findByType(PillRow).props.items;
  expect(runCountLabel(item.run)).toBe('14 events');
  for (const [index, event] of events.entries()) {
    expect(item.run[index]).toMatchObject({ id: event.id, from: { kind: 'github' },
      event: { verb: 'Merged', number: String(4200 + index), title: `Change ${index}`, counted: true, mark: 'merged',
        spoken: `Merged PR #${4200 + index} Change ${index}` } });
    item.run[index].event.open.onPress();
    expect(openUrl).toHaveBeenLastCalledWith(event.systemEvent!.object!.url);
  }
  // Each event keeps its own send time.
  expect(item.run[0].time).not.toBe(item.run[13].time);
  act(() => tree.unmount());
});

it('counts a PR event once when webhook and subscription lines both stored it', () => {
  const line = (id: string): ChatDisplayMessage => ({ id, text: id, isUser: false, timestamp: 1_800_000_000, isSystemNotice: true,
    systemEvent: { subject: { kind: 'github', name: 'GitHub' }, verb: 'merged pull request',
      object: { text: 'Change', url: 'https://github.com/o/r/pull/7' } } });
  const say: ChatDisplayMessage = { id: 'm1', text: 'm1', isUser: false, timestamp: 1_800_000_000, pubkey: 'ruby',
    agentCommand: { kind: 'message', recipient: { id: 'claude', name: 'Claude', kind: 'agent' }, text: 'm1' } };
  const rows = foldPillRuns(foldPrLifecycleRuns([line('hook'), say, line('sub')]));
  const [item] = pillItems(rows[0]!.pillRun!, (id, name) => ({ kind: 'agent', seed: id, name }), {});
  expect(item!.run!.map(entry => entry.id)).toEqual(['hook', 'm1', 'sub']);
  expect(runCountLabel(item!.run!)).toBe('1 message · 1 event');
});

it('opens a thread event in its thread, and a check inside its own thread on GitHub', () => {
  const opened: ChatDisplayMessage = { id: 'open', text: '', isUser: false, timestamp: 1_800_000_000,
    daemonFact: { type: 'corner-open', cornerId: 'c1', objective: 'Fix the stop path', name: 'stop-path' } as never };
  const failed: ChatDisplayMessage = { id: 'fail', text: '', isUser: false, timestamp: 1_800_000_060,
    daemonFact: { type: 'checks-failing', cornerId: 'c2', objective: 'x', name: 'other', pullRequest: { url: 'https://github.com/o/r/pull/9' } } as never };
  const rows = foldPrLifecycleRuns([opened, failed]);
  const openCorner = vi.fn();
  const openUrl = vi.fn();
  const [item] = pillItems(rows, () => ({ kind: 'system', name: 'Beeline' }), { onOpenCorner: openCorner, onOpenUrl: openUrl, cornerId: 'c2' });
  // A thread opening is Beeline's, never GitHub's.
  expect(item!.run![0]).toMatchObject({ from: { kind: 'system', name: 'Beeline' },
    event: { source: 'beeline', verb: 'Opened thread', mark: 'thread', title: 'stop-path', spoken: 'Opened thread stop-path' } });
  item!.run![0]!.event!.open!.onPress();
  expect(openCorner).toHaveBeenCalledWith('c1');
  expect(item!.run![1]).toMatchObject({ from: { kind: 'github' }, event: { source: 'github', verb: 'Failed', mark: 'failed', number: '9' } });
  item!.run![1]!.event!.open!.onPress();
  expect(openUrl).toHaveBeenCalledWith('https://github.com/o/r/pull/9');
});

it('draws a lone GitHub event and payments as separate closed pills', () => {
  const merge: ChatDisplayMessage = { id: 'e1', text: '', isUser: false, timestamp: 1_800_000_000, isSystemNotice: true,
    systemEvent: { subject: { kind: 'github', name: 'GitHub' }, verb: 'merged pull request',
      object: { text: 'Change', url: 'https://github.com/o/r/pull/7' } } };
  const [lone] = foldPrLifecycleRuns([merge]);
  const items = pillItems([lone!], () => ({ kind: 'system', name: 'Beeline' }), {});
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: 'e1', system: false, from: { kind: 'github' }, event: { mark: 'merged' } });
  expect(items[0]!.run).toBeUndefined();
  const payment: ChatDisplayMessage = { id: 'p1', text: '', isUser: false, timestamp: 1_800_000_000,
    walletTx: { direction: 'out', amountText: '$1', counterparty: 'x', chain: 'base', balanceAfterUsd: '$9', txUrl: 'https://e.com' } as never };
  const [paid] = foldPrLifecycleRuns([payment]);
  let tree: any;
  act(() => { tree = create(<TranscriptPills run={[paid!]} resolve={() => ({ kind: 'system', name: 'Beeline' })} />); });
  expect(tree.root.findAllByType(PillRow)).toHaveLength(1);
  act(() => tree.unmount());
});

// Exercise the production chat renderer's row choice with native hosts replaced.
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), phoneOperationFailureReason: vi.fn() }));
vi.mock('@/components/buzz/VaultSaveCard', () => ({ VaultSaveCard: () => null }));
vi.mock('@/components/buzz/AgentSignInCard', () => ({
  AgentSignInCard: ({ testID, isOwner, onSubmit }: any) => React.createElement('Button', {
    testID, onPress: isOwner ? () => onSubmit('synthetic-code') : undefined,
  }),
}));
vi.mock('@/components/buzz/ComputerSession', () => ({ ComputerSessionCard: () => null }));
vi.mock('@/app/(app)/beeline/chat/RepositoryOnboardingCard', () => ({ RepositoryOnboardingCard: () => null }));
vi.mock('@/app/(app)/beeline/chat/chat-surface-values', () => ({
  knownAgentPubkeysFor: (agents: Map<string, unknown>) => new Set(agents.keys()),
  rosterAgent: () => undefined, durableFactLine: () => '',
}));
vi.mock('@/buzz/room-message-cell', () => ({
  messageFailureGroups: () => new Map(), archiveActionPresentation: () => ({}),
  liveCardPresentation: () => ({}), messageRosterPresentation: () => ({}),
  useRoomMessageRenderItem: ({ render }: any) => ({ item }: any) => render(item, {}),
}));
vi.mock('@/app/(app)/beeline/chat/RoomMessageVariants', async () => {
  const { agentCommandTranscriptMessage } = await import('@/buzz/agent-command-transcript');
  const { Text } = await import('react-native');
  return {
    agentCommandTranscriptMessage,
    OrdinaryLedgerMessage: ({ message }: any) => <Text>{message.text}</Text>,
    SwipeToReply: ({ children }: any) => <>{children}</>,
    GitHubEventCard: () => null, NotificationLifecycleCard: () => null, DaemonFactCard: () => null,
    GrantRequestCard: () => null, SquireApprovalCard: ({ message, viewerPubkey }: any) =>
      <Text testID={`approval-${message.id}`}>{viewerPubkey === message.squireApproval.owner?.pubkey
        ? message.squireApproval.approvalUrl : message.squireApproval.title}</Text>,
    ConnectorOfferCard: () => null,
    AppSignInCard: () => null, ChoiceCard: () => null, WalletCards: () => null,
    TargetBranchProposalCard: () => null, WritePermissionCard: () => null,
  };
});
import { useChatTranscriptRenderer } from '@/app/(app)/beeline/chat/useChatTranscriptRenderer';
import { displayRoomMessage } from '@/buzz/room-view-presentation';
import { foldTranscriptRows } from '@/buzz/room-message-store';
import { newestVisibleMessageId } from '@/buzz/read-cursor-advance';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

it.each([false, true])('UAR-1 chat renders person-facing report text immediately (desktop=%s)', desktop => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const args: unknown[] = Array(68).fill(undefined);
  args[10] = new Map(); args[11] = new Map(); args[12] = new Map([['ruby', {}], ['worker', {}]]);
  args[13] = []; args[17] = {}; args[20] = desktop; args[51] = desktop;
  args[52] = new Set(); args[53] = new Set(); args[54] = new Set();
  args[55] = { states: new Map(), retry: vi.fn() }; args[62] = [];
  const message = (kind: 'human' | 'agent' | undefined): ChatDisplayMessage => ({
    id: 'report', text: 'Ruby reported to recipient', isUser: false, timestamp: 1_800_000_000,
    pubkey: 'ruby', isAgentAuthor: true, mentionPubkeys: ['worker'],
    agentCommand: { kind: 'report', recipient: { id: 'recipient', name: 'Recipient', handle: 'recipient', kind },
      text: 'needs-decision: Choose the endpoint' },
  });
  function Harness({ kind }: { kind: 'human' | 'agent' | undefined }) {
    const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
    return render({ item: message(kind) });
  }
  let tree: any;
  act(() => { tree = create(<Harness kind="human" />); });
  const renderedText = () => tree.root.findAllByType('Text').flatMap((node: any) => node.props.children).join(' ');
  expect(renderedText()).toContain('@recipient needs-decision: Choose the endpoint');
  act(() => tree.update(<Harness kind={undefined} />));
  expect(renderedText()).toContain('@recipient needs-decision: Choose the endpoint');
  act(() => tree.update(<Harness kind="agent" />));
  expect(renderedText()).not.toContain('Choose the endpoint');
  act(() => tree.unmount());
});

it('PR-CHAT-ONLY uses large PR cards and small failed-head lines with no PR title or number', async () => {
  const { RepositoryLifecycleRow } = await import('./PrLifecycleCard');
  const base = { id: 'copy', title: 'Setup: quiet defaults', kindLine: 'PR #112',
    url: 'https://github.com/owner/widgets/pull/112', actor: '', updatedBy: 'copy' };
  let tree: any;
  act(() => { tree = create(<RepositoryLifecycleRow item={{ ...base, kind: 'pull-request', state: 'PR opened' }} onOpenCorner={() => {}} onOpenUrl={() => {}} />); });
  expect(tree.root.findAllByType('Text').map((node: any) => node.props.v)).toContain('body');
  expect(tree.root.findAllByType('Text').map((node: any) => node.props.v)).toContain('heading');
  act(() => { tree.update(<RepositoryLifecycleRow item={{ ...base, kind: 'check', state: 'Failed check', title: '82828a8' }} onOpenCorner={() => {}} onOpenUrl={() => {}} />); });
  const text = tree.root.findAllByType('Text');
  expect(text.map((node: any) => node.props.v)).not.toContain('heading');
  expect(text.map((node: any) => node.props.v)).not.toContain('body');
  const words = (value: any): string => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(words).join('') : value?.props ? words(value.props.children) : '';
  expect(words(text[0].props.children)).toBe('Failed check 82828a8');
  act(() => tree.unmount());
});

it('keeps a lone thread opening in a Room with no repository on the Beeline ring', () => {
  const opened: ChatDisplayMessage = { id: 'open', text: '', isUser: false, timestamp: 1_800_000_000,
    daemonFact: { type: 'corner-open', cornerId: 'c1', objective: 'Plan the launch', name: 'launch-plan' } as never };
  const rows = foldPillRuns(foldPrLifecycleRuns([opened]));
  const items = pillItems(rows[0]!.pillRun ?? [rows[0]!], () => ({ kind: 'system', name: 'Beeline' }), { onOpenCorner: vi.fn() });
  expect(items).toEqual([expect.objectContaining({ from: { kind: 'system', name: 'Beeline' },
    event: expect.objectContaining({ source: 'beeline', mark: 'thread' }) })]);
});

const ROOM = '33333333-3333-4333-8333-333333333333';
const person = { kind: 'human', pubkey: 'a'.repeat(64), name: 'Ada' } as const;
const agent = { kind: 'agent', pubkey: 'b'.repeat(64), name: 'Agent' } as const;
const system = { kind: 'human', pubkey: SYSTEM_IDENTITY_PUBKEY, name: 'System' } as const;
const idFor = (number: number) => number.toString(16).padStart(64, '0');
const noticeId = idFor(7);
const bodyId = `system-line-${noticeId}`;
const mockHeading = 'Approval timed out for Morning card 24 Nov';

function display(number: number, patch: Partial<RoomViewMessage> = {}) {
  const value = readRoomViewMessage({
    id: idFor(number), text: 'Member speech', createdAt: 1_800_000_000 + number,
    author: person, presentation: 'message', ...patch,
  });
  expect(value).toBeTruthy();
  return displayRoomMessage(value!, person.pubkey);
}

function TranscriptFixture({ rows, desktop, openCorner = vi.fn() }: {
  rows: ChatDisplayMessage[]; desktop: boolean; openCorner?: (id: string) => void;
}) {
  const args: unknown[] = Array(68).fill(undefined);
  Object.assign(args, {
    0: false, 10: new Map(), 11: new Map(), 12: new Map(), 13: [],
    14: ROOM, 15: person.pubkey, 17: {}, 18: openCorner, 20: desktop, 30: vi.fn(),
    50: desktop, 51: new Set(), 52: new Set(), 53: new Set(),
    54: { states: new Map(), retry: vi.fn() }, 55: {}, 56: new Map(), 61: rows,
  });
  const [render] = useChatTranscriptRenderer(args as Parameters<typeof useChatTranscriptRenderer>[0]);
  return <>{(desktop ? rows : [...rows].reverse()).map(row => <React.Fragment key={row.id}>{render({ item: row })}</React.Fragment>)}</>;
}

const notice = { origin: 'system', visibility: 'notice' } as const;
const card = { origin: 'system', visibility: 'card' } as const;
const approvalUrl = 'https://approval.example/owner';
const voice = { id: ROOM, roomId: ROOM, startedAt: 1_800_000_000, participants: [] };
const systemCases: { name: string; patch: Partial<RoomViewMessage>; opened: string; copy?: string; visibleOnArrival?: boolean }[] = [
  { name: 'plain workflow expiry', patch: { presentation: 'system', systemTranscript: notice, text: mockHeading },
    opened: bodyId, copy: mockHeading },
  { name: 'kinded workflow handoff', visibleOnArrival: true, patch: { presentation: 'card', systemTranscript: card, author: agent,
    systemEvent: { kind: 'workflow-handoff', subject: { kind: 'agent', name: 'Agent' }, verb: 'passed approval' } }, opened: bodyId },
  { name: 'plain notice', patch: { presentation: 'system', text: 'Ada joined' }, opened: bodyId, copy: 'Ada joined' },
  { name: 'ended call', patch: { presentation: 'system', voiceCall: { ...voice, endedAt: 1_800_000_003 },
    text: 'Voice call ended' }, opened: bodyId, copy: 'Voice call ended' },
  { name: 'deleted member row', patch: { presentation: 'system', deleted: true, text: 'Ada deleted a message' },
    opened: bodyId, copy: 'Ada deleted a message' },
  { name: 'legacy System DM', patch: { text: 'Operator notice', author: system }, opened: bodyId, copy: 'Operator notice' },
  { name: 'approval', visibleOnArrival: true, patch: { presentation: 'card', systemTranscript: card, squireApproval: {
    agent, owner: person, title: 'Approve the request', detail: 'Example request', tool: 'operate_login',
    linkKind: 'approval', approvalUrl,
  } }, opened: `approval-${noticeId}`, copy: approvalUrl },
  { name: 'sign-in', visibleOnArrival: true, patch: { presentation: 'card', systemTranscript: card, agentSignIn: {
    agentId: agent.pubkey, ownerId: person.pubkey, harness: 'pi', status: 'pending',
    kind: 'api-key', provider: 'openrouter',
  } }, opened: `agent-sign-in-${noticeId}` },
  { name: 'wallet record', patch: { presentation: 'card', systemTranscript: card,
    walletTx: { direction: 'out', amountText: '$1', counterparty: 'Example', chain: 'base', balanceAfterUsd: '$9' } },
    opened: `notification-run-${noticeId}` },
  { name: 'wallet delegation record', patch: { presentation: 'card', systemTranscript: card,
    walletDelegation: { standing: true } }, opened: `notification-run-${noticeId}` },
  { name: 'provider lifecycle', patch: { presentation: 'system', systemTranscript: { origin: 'github', visibility: 'notice' },
    systemEvent: { kind: 'merged', subject: { kind: 'github', name: 'GitHub' }, verb: 'merged pull request',
      object: { text: 'Fix labels', url: 'https://github.com/example/example/pull/7' } } },
    opened: `pill-event-text-${noticeId}` },
];

it.each(systemCases.flatMap(entry => [false, true].map(desktop => ({ ...entry, desktop }))))(
  'renders $name at each transcript position (desktop=$desktop)',
  async ({ patch, opened, copy, desktop, name, visibleOnArrival }) => {
    for (const position of ['lone', 'first', 'middle', 'last']) {
      const target = display(7, patch);
      if (name === 'approval') target.agentCommand = { kind: 'message', recipient: { id: 'emberus', name: 'Emberus', kind: 'agent' }, text: 'Review the request' };
      const members = [display(1), display(2)];
      const input = position === 'lone' ? [target] : position === 'first' ? [target, ...members]
        : position === 'middle' ? [members[0]!, target, members[1]!] : [...members, target];
      const folded = foldTranscriptRows(input, noticeId);
      expect(folded.hostIds.get(noticeId)).toBe(noticeId);
      let tree: any;
      act(() => { tree = create(<TranscriptFixture rows={folded.rows} desktop={desktop} />); });
      const body = () => tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === opened);
      const pills = tree.root.findAllByType(PillRow);
      if (visibleOnArrival) {
        expect(pills).toHaveLength(0);
      } else {
        expect(pills).toHaveLength(1);
        expect(pills[0].props.items.map((item: { id: string }) => item.id)).toEqual([noticeId]);
        expect(body()).toHaveLength(0);
        act(() => pills[0].findByType('Button').props.onPress());
      }
      expect(body()).toHaveLength(1);
      if (copy) expect(body()[0].props.children).toBe(copy);
      if (name === 'sign-in') {
        await act(async () => body()[0].props.onPress());
        expect(monolithPhoneOperation).toHaveBeenLastCalledWith('completeAgentSignIn', {
          roomId: ROOM, messageId: noticeId, code: 'synthetic-code',
        });
      }
      act(() => tree.unmount());
    }
  },
);

it.each([false, true])('preserves unread run boundaries, jumps and hidden records (desktop=%s)', desktop => {
  const stop = display(3, {
    presentation: 'system', text: 'Ada stopped Agent', systemEvent: {
      kind: 'turn-cancelled', subject: { kind: 'person', id: person.pubkey, name: person.name },
      verb: 'stopped', object: { text: agent.name, id: agent.pubkey },
    },
  });
  const lifecycle = display(4, systemCases.at(-1)!.patch);
  const hidden = display(5, { presentation: 'system', text: 'A private receipt', systemTranscript: {
    origin: 'system', visibility: 'hidden',
  } });
  const active = display(6, { presentation: 'card', voiceCall: voice, text: 'Active call' });
  const later = display(8, systemCases.at(-1)!.patch);
  const folded = foldTranscriptRows([stop, lifecycle, hidden, active, later], later.id);
  expect(folded.rows.map(row => row.id)).toEqual([stop.id, later.id]);
  expect(folded.hostIds.get(lifecycle.id)).toBe(stop.id);
  expect(folded.hostIds.has(hidden.id)).toBe(false);
  expect(folded.hostIds.has(active.id)).toBe(false);
  let tree: any;
  act(() => { tree = create(<TranscriptFixture rows={folded.rows} desktop={desktop} />); });
  const pills = tree.root.findAllByType(PillRow);
  expect(pills).toHaveLength(2);
  const mixed = pills.find((pill: any) => pill.props.items[0].id === stop.id);
  expect(mixed.props.items[0].run.map((entry: { id: string }) => entry.id)).toEqual([stop.id, lifecycle.id]);
  act(() => mixed.findByType('Button').props.onPress());
  const ids = tree.root.findAllByType('Text').map((node: any) => node.props.testID);
  expect(ids).toContain(`system-line-${stop.id}`);
  expect(ids).toContain(`pill-event-text-${lifecycle.id}`);
  expect(ids).not.toContain(`system-line-${hidden.id}`);
  expect(ids).not.toContain(`pill-event-text-${later.id}`);
  act(() => tree.unmount());
});

it('keeps a thread opening pilled at its source message and opens the thread from the pill', () => {
  const source = display(1);
  const cornerId = '55555555-5555-4555-8555-555555555555';
  const marker = display(3, { presentation: 'card', systemTranscript: card,
    daemonFact: { type: 'corner-open', cornerId, name: 'sample-thread', objective: '', sourceMessageId: source.id },
  });
  const folded = foldTranscriptRows([source, display(2), marker], null);
  expect(folded.hostIds.get(marker.id)).toBe(marker.id);
  expect(folded.rows.map(row => row.id)).toEqual([source.id, marker.id, idFor(2)]);
  expect(newestVisibleMessageId(folded.rows, [folded.rows[2]!])).toBe(marker.id);
  const openCorner = vi.fn();
  let tree: any;
  act(() => { tree = create(<TranscriptFixture rows={folded.rows} desktop openCorner={openCorner} />); });
  const pill = tree.root.findByType(PillRow);
  expect(pill.props.items[0]).toMatchObject({ id: marker.id, event: { source: 'beeline', mark: 'thread' } });
  expect(tree.root.findAllByProps({ testID: `pill-event-open-${marker.id}` })).toHaveLength(0);
  act(() => pill.findByType('Button').props.onPress());
  const action = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === `pill-event-${marker.id}`);
  act(() => action.props.onPress());
  expect(openCorner).toHaveBeenCalledWith(cornerId);
  act(() => tree.unmount());
});

it('renders one phone pill for an anchored thread opening followed by a PR opening', () => {
  const source = display(1, { text: '@carbon yes go' });
  const marker = display(2, { presentation: 'card', systemTranscript: card,
    daemonFact: { type: 'corner-open', cornerId: ROOM, name: 'sample-thread', objective: '', sourceMessageId: source.id },
  });
  const opened = display(3, {
    presentation: 'system', systemTranscript: { origin: 'github', visibility: 'notice' },
    systemEvent: { subject: { kind: 'github', name: 'GitHub' }, verb: 'opened pull request',
      object: { text: 'Fix labels', url: 'https://github.com/example/example/pull/7' } },
  });
  const folded = foldTranscriptRows([source, marker, opened], null);
  expect(folded.rows.map(row => row.id)).toEqual([source.id, marker.id]);
  expect(folded.hostIds.get(opened.id)).toBe(marker.id);
  let tree: any;
  act(() => { tree = create(<TranscriptFixture rows={folded.rows} desktop={false} />); });
  const pills = tree.root.findAllByType(PillRow);
  expect(pills).toHaveLength(1);
  expect(pills[0].props.items).toHaveLength(1);
  expect(pills[0].props.items[0].run).toMatchObject([
    { id: marker.id, event: { source: 'beeline', mark: 'thread' } },
    { id: opened.id, event: { source: 'github', mark: 'opened' } },
  ]);
  act(() => tree.unmount());
});
