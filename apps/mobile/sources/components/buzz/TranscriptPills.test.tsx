import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('@/ui/grammar', () => ({ T: 'Text', TypedView: 'View', Inked: 'Pressable', HEIGHT: { control: 44, row: 44 } }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({ theme: { buzz: {} } }),
}));
vi.mock('./Ledger', () => ({ ledgerEntryRhythm: () => ({}), LedgerSystemLine: () => null,
  LedgerEntryFrame: ({ children, testID }: any) => React.createElement('View', { testID }, children) }));
vi.mock('./Ledger-styles', () => ({ settledAgentProseStyle: () => ({}) }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: () => null }));
vi.mock('@/ui/screens/transcript/PillRow', async (original) => ({ ...(await original<object>()), PillRow: () => <React.Fragment /> }));
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
import { PillRow } from '@/ui/screens/transcript/PillRow';

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

it('folds agent messages, stops and system notices in a row into one PillRow pill, in send order', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const resolve = (id: string, name: string, kind?: 'agent' | 'human') => ({ kind: kind ?? 'agent', seed: id, name });
  const base = (id: string, fields: Partial<ChatDisplayMessage>): ChatDisplayMessage =>
    ({ id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields });
  const say = (id: string, from: string, to: string) => base(id, { pubkey: from, authorIdentity: { pubkey: from, name: from, kind: 'agent' },
    agentCommand: { kind: 'message', recipient: { id: to, name: to, kind: 'agent' }, text: id } });
  const stop = (id: string, by: string, kind: 'person' | 'agent', whom: string) => base(id, { isSystemNotice: true, pubkey: by,
    systemEvent: { kind: 'turn-cancelled', subject: { kind, id: by, name: by }, verb: 'stopped', object: { text: whom, id: whom } } });
  const run = [
    say('m1', 'ruby', 'claude'), stop('s1', 'ruby', 'agent', 'claude'), say('m2', 'claude', 'ruby'),
    stop('s2', 'owner', 'person', 'ruby'),
    say('m3', 'ruby', 'jelly'), say('m4', 'jelly', 'ruby'),
    base('joined', { isSystemNotice: true, text: 'Nerd joined' }),
    say('m5', 'ruby', 'nerd'),
  ];
  const items = pillItems(run, resolve, {});
  expect(items.map(item => [item.id, item.system, item.run?.map(entry => entry.id) ?? null])).toEqual([
    ['m1', false, ['m1', 's1', 'm2', 's2', 'm3', 'm4', 'joined', 'm5']]]);
  const entries = items[0]!.run!;
  expect(entries[1]).toMatchObject({ stop: true, from: { seed: 'ruby' }, to: { seed: 'claude' } });
  expect(entries[3]).toMatchObject({ stop: true, from: { kind: 'human', seed: 'owner' }, to: { seed: 'ruby' } });
  expect(entries[6]).toMatchObject({ system: true, summary: 'Nerd joined', from: { kind: 'system' } });
  // Every opened pill reads as a run row: the heading names the recipient, so the body drops the @mention and reads quieter.
  expect(entries[0]!.body).toMatchObject({ props: { markdown: 'm1', color: 'secondary' } });
  expect(pillItems([say('m5', 'ruby', 'nerd')], resolve, {})[0]!.body).toMatchObject({ props: { markdown: 'm5', color: 'secondary' } });
  let tree: any;
  act(() => { tree = create(<TranscriptPills run={run} resolve={resolve} />); });
  expect(tree.root.findByType(PillRow).props.items.map((item: any) => item.id)).toEqual(['m1']);
  act(() => tree.unmount());
});

it('folds consecutive system notices, person stops included, into one pill that opens in send order', () => {
  const resolve = (id: string, name: string, kind?: 'agent' | 'human') => ({ kind: kind ?? 'agent', seed: id, name });
  const base = (id: string, fields: Partial<ChatDisplayMessage>): ChatDisplayMessage =>
    ({ id, text: id, isUser: false, timestamp: 1_800_000_000, ...fields });
  const notice = (id: string, who?: string) => base(id, { isSystemNotice: true,
    ...(who ? { systemEvent: { subject: { kind: 'agent', id: who, name: who }, verb: 'joined' } } : {}) });
  const personStop = base('s1', { isSystemNotice: true, pubkey: 'owner',
    systemEvent: { kind: 'turn-cancelled', subject: { kind: 'person', id: 'owner', name: 'owner' }, verb: 'stopped', object: { text: 'ruby', id: 'ruby' } } });
  const say = (id: string, from: string, to: string) => base(id, { pubkey: from, authorIdentity: { pubkey: from, name: from, kind: 'agent' },
    agentCommand: { kind: 'message', recipient: { id: to, name: to, kind: 'agent' }, text: id } });
  const items = pillItems([notice('n1', 'nerd'), personStop, notice('n2')], resolve, {});
  expect(items.map(item => [item.id, item.system, item.run?.map(entry => entry.id) ?? null])).toEqual([
    ['n1', true, ['n1', 's1', 'n2']]]);
  expect(items[0]!.run![1]).toMatchObject({ stop: true, from: { kind: 'human', seed: 'owner' }, to: { seed: 'ruby' } });
  // One agent message in the stretch makes it a mixed run, not a system stack.
  expect(pillItems([notice('n1', 'nerd'), say('m1', 'ruby', 'claude')], resolve, {})[0]).toMatchObject({ system: false });
});

it('MERGE-ROWS-1 shows the merge count immediately and expands every stored event and destination', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const events: ChatDisplayMessage[] = Array.from({ length: 14 }, (_, index) => ({
    id: `merge-${index}`, text: `Merged change ${index}`, timestamp: 1_800_000_000 + index,
    isUser: false, isSystemNotice: true,
    systemEvent: { subject: { kind: 'github', name: 'GitHub' },
      verb: 'merged pull request', object: { text: `Change ${index}`, url: `https://github.com/Beeline-Work/beeline/pull/${4200 + index}` } },
  }));
  const rows = foldPillRuns(foldPrLifecycleRuns(events));
  const openUrl = vi.fn();
  let tree: any;
  act(() => { tree = create(<>{rows.map(row => <TranscriptPills key={row.id}
    run={row.pillRun ?? [row]} resolve={() => ({ kind: 'system', name: 'Beeline' })} onOpenUrl={openUrl} />)}</>); });
  const control = (id: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
  expect(control('notification-run-expand-merge-0').props.accessibilityLabel).toBe('14 PRs merged');
  act(() => control('notification-run-expand-merge-0').props.onPress());
  expect(control('notification-run-more-merge-0').props.accessibilityLabel).toBe('12 more events');
  act(() => control('notification-run-more-merge-0').props.onPress());
  for (const [index, event] of events.entries()) {
    const row = control(`notification-run-cell-${event.id}`);
    const copy = row.findAll((node: any) => node.type === 'Text').flatMap((node: any) => node.children);
    expect(copy).toContain(`Change ${index}`);
    act(() => row.props.onPress());
    expect(openUrl).toHaveBeenLastCalledWith(event.systemEvent!.object!.url);
  }
  act(() => control('notification-run-expand-merge-0').props.onPress());
  expect(control('notification-run-expand-merge-0').props.accessibilityState.expanded).toBe(false);
  act(() => control('notification-run-expand-merge-0').props.onPress());
  expect(control('notification-run-more-merge-0').props.accessibilityLabel).toBe('12 more events');
  act(() => tree.unmount());
});

// Exercise the production chat renderer's row choice with native hosts replaced.
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), phoneOperationFailureReason: vi.fn() }));
vi.mock('@/components/buzz/VaultSaveCard', () => ({ VaultSaveCard: () => null }));
vi.mock('@/components/buzz/AgentSignInCard', () => ({ AgentSignInCard: () => null }));
vi.mock('@/components/buzz/ComputerSession', () => ({ ComputerSessionCard: () => null }));
vi.mock('@/components/buzz/CornerOpenedMarker', () => ({ CornerOpenedMarkers: () => null }));
vi.mock('@/components/buzz/GrantRequestCard', () => ({ canDecideGrantRequest: () => false, GrantRequestPill: () => null }));
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
    GrantRequestCard: () => null, SquireApprovalCard: () => null, ConnectorOfferCard: () => null,
    AppSignInCard: () => null, ChoiceCard: () => null, WalletCards: () => null,
    TargetBranchProposalCard: () => null, WritePermissionCard: () => null,
  };
});
import { useChatTranscriptRenderer } from '@/app/(app)/beeline/chat/useChatTranscriptRenderer';

it.each([false, true])('UAR-1 chat renders person-facing report text immediately (desktop=%s)', desktop => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const args: unknown[] = Array(69).fill(undefined);
  args[10] = new Map(); args[11] = new Map(); args[12] = new Map([['ruby', {}], ['worker', {}]]);
  args[13] = []; args[17] = {}; args[20] = desktop; args[52] = desktop;
  args[53] = new Set(); args[54] = new Set(); args[55] = new Set();
  args[56] = { states: new Map(), retry: vi.fn() }; args[63] = [];
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
