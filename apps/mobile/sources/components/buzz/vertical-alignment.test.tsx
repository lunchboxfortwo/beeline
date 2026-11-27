import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkBoardView } from '@beeline/api-contract/phone';

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default },
  useWindowDimensions: () => ({ height: 844, width: 390 }),
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/buzz/IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('@/ui/shell/TabHeader', () => ({
  TabHeader: () => null,
  useScrolledUnder: () => ({ scrolled: false, scrollProps: {} }),
}));
vi.mock('@/ui/screens/tags/WorkItemDetail', () => ({
  WorkSheet: () => null,
}));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/buzz/room-corner-store', () => ({ findRoomCornerRow: () => undefined, useRoomCornerRecord: () => null }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/buzz/use-observed-resource', () => ({ useObservedResource: () => ({ data: null }), observeRoomResource: () => undefined }));
vi.mock('@/buzz/use-room-workflow-run', () => ({ useRoomWorkflowRun: () => ({ workflow: undefined }) }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));

import { Clock } from 'lucide-react-native';
import { HEIGHT, Row, T, TextSizeContext, typeStyle, type TextSize } from '@/ui/grammar';
import { TranscriptNavigationRow } from './IndexRow';
import { RepositoryLifecycleRow } from './PrLifecycleCard';
import { TranscriptCard } from './TranscriptCard';
import { Choice } from '@/ui/screens/onboarding/OnboardingFrame';
import { ChoiceOption } from '@/ui/screens/transcript/cards/ChoiceOption';
import { TranscriptCardChoicePlate } from './ChoicePlate';
import { MonoMarkdown } from './MonoMarkdown';
import { WorkBoard } from '@/ui/screens/tags/WorkBoard';
import { RequestFrame, SettledLine } from '@/ui/screens/transcript/cards/RequestCard';
import { WorkflowRunCardView } from '@/ui/screens/transcript/cards/WorkflowRunCard';
import { WorkflowRunLine } from './WorkflowRunLine';
import { AgentUsage } from '@/ui/screens/profiles/AgentUsage';
import type { WorkflowRunDetailView } from '@beeline/api-contract/phone';

const SIZES: TextSize[] = ['small', 'medium', 'large'];

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

function renderAt(textSize: TextSize, element: React.ReactElement) {
  let tree: any;
  act(() => {
    tree = create(<TextSizeContext.Provider value={textSize}>{element}</TextSizeContext.Provider>);
  });
  return tree;
}

describe('UI vertical alignment sweep', () => {
  it('centers TranscriptNavigationRow copy and row axis in single and dual destination modes', () => {
    const single = renderAt(
      'medium',
      <TranscriptNavigationRow
        testID="single-row"
        singleDestination
        trailing={{ onPress: vi.fn(), testID: 'single-open' }}
      >
        <T v="meta">Opened thread lightweight-math-rendering</T>
      </TranscriptNavigationRow>,
    );
    try {
      const row = single.root.find((n: any) => n.type === 'XStack' && n.props.testID === 'single-open');
      expect(row.props.alignItems).toBe('center');
      const copy = row.find((n: any) => n.type === 'YStack' && n.props.flex === 1);
      expect(copy.props.minHeight).toBe(HEIGHT.control);
      expect(copy.props.justifyContent).toBe('center');
    } finally {
      act(() => single.unmount());
    }

    const dual = renderAt(
      'medium',
      <TranscriptNavigationRow
        testID="dual-row"
        primary={{ onPress: vi.fn(), testID: 'dual-primary' }}
        trailing={{ onPress: vi.fn(), testID: 'dual-trailing' }}
      >
        <T v="body">Merged #182 Lightweight math rendering</T>
      </TranscriptNavigationRow>,
    );
    try {
      const row = dual.root.find((n: any) => n.type === 'XStack' && n.props.testID === 'dual-row');
      expect(row.props.alignItems).toBe('center');
      const copy = row.find((n: any) => n.type === 'YStack' && n.props.testID === 'dual-primary');
      expect(copy.props.minHeight).toBe(HEIGHT.control);
      expect(copy.props.justifyContent).toBe('center');
    } finally {
      act(() => dual.unmount());
    }
  });

  it('removes manual y and marginVertical offset hacks from PrLifecycleCard', () => {
    const cornerItem = {
      id: 'c1',
      kind: 'corner' as const,
      state: 'Opened',
      title: 'lightweight-math-rendering',
      kindLine: 'Thread',
      cornerId: 'corner-1',
      actor: 'crayon',
      updatedBy: 'c1',
    };
    const cornerTree = renderAt(
      'medium',
      <RepositoryLifecycleRow item={cornerItem} onOpenCorner={vi.fn()} onOpenUrl={vi.fn()} />,
    );
    try {
      const baselineRow = cornerTree.root.find((n: any) => n.type === 'XStack' && n.props.alignItems === 'baseline');
      expect(baselineRow.props.y).toBeUndefined();
    } finally {
      act(() => cornerTree.unmount());
    }

    const checkItem = {
      id: 'chk1',
      kind: 'check' as const,
      state: 'Failed check',
      title: '82828a8',
      kindLine: 'Check',
      url: 'https://github.com/owner/repo/runs/1',
      actor: '',
      updatedBy: 'chk1',
    };
    const checkTree = renderAt(
      'medium',
      <RepositoryLifecycleRow item={checkItem} onOpenCorner={vi.fn()} onOpenUrl={vi.fn()} />,
    );
    try {
      const copyText = checkTree.root.find((n: any) => n.type === 'Text' && n.props.numberOfLines === 2);
      expect(copyText.props.marginVertical).toBeUndefined();
    } finally {
      act(() => checkTree.unmount());
    }
  });

  it.each(SIZES)('anchors grammar Row icon and chevron to body lineHeight at %s text size', (size) => {
    const expectedLine = typeStyle('body', size).lineHeight;
    const tree = renderAt(
      size,
      <Row label="Schedules & wakes" detail="Manage recurring checks" icon={Clock} onPress={vi.fn()} testID="settings-row" />,
    );
    try {
      const iconHost = tree.root.find((n: any) => n.type === 'Icon.Clock');
      const chevronHost = tree.root.find((n: any) => n.type === 'Icon.ChevronRight');
      const lineBoxes = tree.root.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === expectedLine && n.props.justifyContent === 'center',
      );
      expect(lineBoxes).toHaveLength(2);
      expect(lineBoxes.some((box: any) => box.findAll((c: any) => c === iconHost).length === 1)).toBe(true);
      expect(lineBoxes.some((box: any) => box.findAll((c: any) => c === chevronHost).length === 1)).toBe(true);
      const nudged = tree.root.findAll((n: any) => n.type === 'YStack' && n.props.paddingTop === '0.5');
      expect(nudged).toHaveLength(0);
    } finally {
      act(() => tree.unmount());
    }
  });

  it.each(SIZES)('aligns TranscriptCard header and anchors CardRow state and chevron at %s text size', (size) => {
    const headingLine = typeStyle('heading', size).lineHeight;
    const bodyLine = typeStyle('body', size).lineHeight;
    const tree = renderAt(
      size,
      <TranscriptCard
        tier="ask"
        title="Grant request"
        stamp="20:10"
        onHeaderPress={vi.fn()}
        onDismiss={vi.fn()}
        headerTestID="card-header"
        rows={[{ id: 'r1', state: 'Waiting', title: 'Run host emulator', kindLine: '127.0.0.1:5037', tone: 'waiting', onPress: vi.fn() }]}
        testID="card"
      />,
    );
    try {
      const headerButton = tree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'card-header');
      const headRow = headerButton.find((n: any) => n.type === 'XStack' && n.props.flex === 1);
      expect(headRow.props.alignItems).toBe('center');
      const headerLineWrappers = headRow.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === headingLine && n.props.justifyContent === 'center',
      );
      expect(headerLineWrappers).toHaveLength(2);

      const cardRow = tree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'transcript-card-row-r1');
      const stateBox = cardRow.find((n: any) => n.type === 'YStack' && n.props.width === 80);
      expect(stateBox.props.height).toBe(bodyLine);
      expect(stateBox.props.justifyContent).toBe('center');
      const chevronBox = cardRow.find(
        (n: any) => n.type === 'YStack' && n.props.height === bodyLine && n.props.justifyContent === 'center' && n.props.width === undefined,
      );
      expect(chevronBox.findAll((n: any) => n.type === 'Icon.ChevronRight')).toHaveLength(1);
    } finally {
      act(() => tree.unmount());
    }

    const multi = renderAt(
      size,
      <TranscriptCard
        tier="record"
        title="Wallet transfer"
        subline="0xabc · Base · $12 left"
        stamp="20:10"
        onHeaderPress={vi.fn()}
        onDismiss={vi.fn()}
        headerTestID="multi-header"
        testID="multi-card"
      />,
    );
    try {
      const headerButton = multi.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'multi-header');
      const headRow = headerButton.find((n: any) => n.type === 'XStack' && n.props.flex === 1);
      expect(headRow.props.alignItems).toBe('flex-start');
      const dismissBtn = headRow.find((n: any) => n.type === 'Button' && n.props.testID === 'multi-card-dismiss');
      expect(dismissBtn.props.minWidth).toBe(HEIGHT.control);
      expect(dismissBtn.props.minHeight).toBe(HEIGHT.control);
      expect(dismissBtn.props.alignItems).toBe('flex-start');
      const headerLineWrappers = headRow.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === headingLine && n.props.justifyContent === 'center',
      );
      expect(headerLineWrappers).toHaveLength(3);
    } finally {
      act(() => multi.unmount());
    }
  });

  it('centers OnboardingFrame Choice card without manual chevron paddingTop', () => {
    const tree = renderAt(
      'medium',
      <Choice
        icon={Clock}
        title="Connect your own agent"
        line="Run Claude, Codex, or Antigravity locally"
        onPress={vi.fn()}
        testID="onboarding-choice"
      />,
    );
    try {
      const item = tree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'onboarding-choice');
      expect(item.props.alignItems).toBe('center');
      const nudged = item.findAll((n: any) => n.type === 'YStack' && n.props.paddingTop === '2');
      expect(nudged).toHaveLength(0);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('centers ChoiceOption and TranscriptCardChoicePlate label, spinner, and votes on the 28px badge axis', () => {
    const choice = {
      id: 'opt-a',
      letter: 'A',
      label: 'Ship Stone theme update first',
      votes: 4,
      busy: true,
      onPress: vi.fn(),
    };
    const optionTree = renderAt('medium', <ChoiceOption choice={{ ...choice, share: 0.6 }} closed />);
    try {
      const wash = optionTree.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'transcript-card-choice-wash-opt-a');
      expect(wash.props.borderRadius).toBe('md');
      const frame = optionTree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'transcript-card-choice-opt-a');
      expect(frame.props.position).toBeUndefined();
      const labelRow = optionTree.root.find((n: any) => n.type === 'XStack' && n.props.flex === 1 && n.props.alignItems === 'center');
      expect(labelRow.findAll((n: any) => n.type === 'YStack' && n.props.width === 0 && n.props.height === 28)).toHaveLength(1);
      const trailingBoxes = optionTree.root.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === 28 && n.props.justifyContent === 'center' && n.props.width === undefined,
      );
      expect(trailingBoxes).toHaveLength(2);
    } finally {
      act(() => optionTree.unmount());
    }

    const plateTree = renderAt('medium', <TranscriptCardChoicePlate choice={choice} closed />);
    try {
      const outer = plateTree.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'transcript-card-choice-opt-a');
      expect(outer.props.justifyContent).toBe('center');
      const badge = plateTree.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'transcript-card-choice-letter-opt-a');
      expect(badge.props.height).toBe(28);
      const labelRow = plateTree.root.find((n: any) => n.type === 'XStack' && n.props.flex === 1 && n.props.alignItems === 'center');
      expect(labelRow.findAll((n: any) => n.type === 'YStack' && n.props.width === 0 && n.props.height === 28)).toHaveLength(1);
      const trailingBoxes = plateTree.root.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === 28 && n.props.justifyContent === 'center' && n.props.minWidth === undefined,
      );
      expect(trailingBoxes).toHaveLength(2);
      const votes = plateTree.root.find((n: any) => n.type === 'Text' && n.props.testID === 'transcript-card-choice-count-opt-a');
      expect(votes.props.paddingTop).toBeUndefined();
    } finally {
      act(() => plateTree.unmount());
    }
  });

  it.each(SIZES)('anchors MonoMarkdown task checkbox to line 1 height at %s text size', (size) => {
    const bodyLine = typeStyle('body', size).lineHeight;
    const tree = renderAt(size, <MonoMarkdown textStyle={{}} markdown={'- [x] Verify alignment across text sizes'} />);
    try {
      const box = tree.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'task-done');
      expect(box.props.marginTop).toBeUndefined();
      const wrapper = tree.root.find(
        (n: any) => n.type === 'YStack' && n.props.height === bodyLine && n.props.justifyContent === 'center',
      );
      expect(wrapper.findAll((n: any) => n === box)).toHaveLength(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('keeps WorkBoard SectionHead spacing outside its 44pt ListItem target', () => {
    const board = {
      workspaceId: 'ws',
      workspaceName: 'Crew',
      viewerId: 'viewer',
      chats: [],
      people: [],
      items: [{ id: 'b1', title: 'Task', state: 'backlog', chatName: 'general', threadName: 'Task' }],
    } as unknown as WorkBoardView;
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    const tree = renderAt('medium', <WorkBoard board={board} desktop={false} actions={actions} />);
    try {
      const head = tree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'work-section-backlog');
      expect(head.props.minHeight).toBe(44);
      expect(head.props.marginTop).toBe('3');
      expect(head.props.paddingVertical).toBe('0');
      expect(head.props.paddingTop).toBeUndefined();
      expect(head.props.paddingBottom).toBeUndefined();
    } finally {
      act(() => tree.unmount());
    }
  });

  it.each(SIZES)('anchors RequestFrame @ and SettledLine mark to line 1 at %s text size', (size) => {
    const bodyLine = typeStyle('body', size).lineHeight;
    const metaLine = typeStyle('meta', size).lineHeight;
    const tree = renderAt(
      size,
      <RequestFrame ask="Approve running the host emulator?" testID="req-frame">
        <SettledLine testID="req-settled">Approved once by lunchboxfortwo</SettledLine>
      </RequestFrame>,
    );
    try {
      expect(tree.root.findAll((n: any) => n.props?.paddingTop === '0.5')).toHaveLength(0);
      const atBox = tree.root.find((n: any) => n.type === 'YStack' && n.props.height === bodyLine && n.props.justifyContent === 'center');
      expect(atBox.findAll((n: any) => n.type === 'Icon.AtSign')).toHaveLength(1);
      const settledRow = tree.root.find((n: any) => n.type === 'XStack' && n.props.alignItems === 'flex-start' && n.findAll((c: any) => c.props?.testID === 'req-settled').length > 0);
      const settledBox = settledRow.find((n: any) => n.type === 'YStack' && n.props.height === metaLine && n.props.justifyContent === 'center');
      expect(settledBox).toBeDefined();
    } finally {
      act(() => tree.unmount());
    }
  });

  it.each(SIZES)('centers WorkflowRunCard header, trailing mark, and continuous rail across %s text size', (size) => {
    const headingLine = typeStyle('heading', size).lineHeight;
    const metaLine = typeStyle('meta', size).lineHeight;
    const stepSlot = Math.max(20, metaLine);
    const actor = { id: 'c', kind: 'agent', name: 'Crayon', handle: 'crayon' } as const;
    const detail = {
      run: { runId: 'r1', workflowSlug: 'verify_alignment', description: '', roomId: 'room', roomName: 'beeline', state: 'review', status: 'live', viewerHolds: false, holder: actor, startedAt: 1, updatedAt: 2, startedBy: actor },
      contract: { handoffs: { build: { kind: 'handoff', role: 'fixer', does: 'Build', on: { done: 'review' } }, review: { kind: 'handoff', role: 'reviewer', does: 'Review', on: { done: 'done' } }, done: { kind: 'terminal', status: 'done' } } },
      history: [
        { toState: 'build', at: 1, actor, displayStatus: 'done' },
        { fromState: 'build', outcome: 'done', toState: 'review', at: 2, actor, displayStatus: 'current', liveOutput: 'Checking.' },
      ],
      roleHolders: { fixer: actor, reviewer: actor },
    } as unknown as WorkflowRunDetailView;

    const card = renderAt(size, <WorkflowRunCardView detail={detail} />);
    try {
      expect(card.root.findAll((n: any) => n.props?.paddingTop === '0.5')).toHaveLength(0);
      const headSlots = card.root.findAll((n: any) => n.type === 'YStack' && n.props.height === headingLine && n.props.justifyContent === 'center');
      expect(headSlots).toHaveLength(2);
      const struts = card.root.findAll((n: any) => n.type === 'YStack' && n.props.width === 0 && n.props.height === stepSlot);
      expect(struts).toHaveLength(3);
      if (metaLine > 20) {
        const topConnectors = card.root.findAll((n: any) => n.type === 'YStack' && n.props.width === 2 && n.props.height === (stepSlot - 20) / 2);
        expect(topConnectors).toHaveLength(3);
      }
    } finally {
      act(() => card.unmount());
    }

    const bodyLine = typeStyle('body', size).lineHeight;
    const line = renderAt(size, <WorkflowRunLine detail={detail} now={10_000} onOpenCorner={vi.fn()} />);
    try {
      const doneStep = line.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'workflow-run-line-step-build');
      const expectedDoneTop = 8 + (Math.max(20, bodyLine) - 20) / 2;
      const doneBelow = doneStep.find((n: any) => n.props?.testID === 'workflow-run-line-step-build-below-brass');
      expect(doneBelow.props.top).toBe(expectedDoneTop + 20);
      const curStep = line.root.find((n: any) => n.type === 'YStack' && n.props.testID === 'workflow-run-line-step-review');
      const expectedCurTop = 8 + (Math.max(20, headingLine) - 20) / 2;
      const curAbove = curStep.find((n: any) => n.props?.testID === 'workflow-run-line-step-review-above-brass');
      expect(curAbove.props.height).toBe(expectedCurTop);
    } finally {
      act(() => line.unmount());
    }
  });

  it.each(SIZES)('pins AgentUsage refresh button and spinner to line 1 while preserving 44pt target at %s text size', (size) => {
    const bodyLine = typeStyle('body', size).lineHeight;
    const onRefresh = vi.fn(() => new Promise(() => {}));
    const tree = renderAt(
      size,
      <AgentUsage
        usage={{ updatedAt: 1_700_000_000, machine: 'squire', windows: [{ label: '5h', usedPercent: 20 }] } as any}
        harness="claude"
        onRefresh={onRefresh}
      />,
    );
    try {
      const btn = tree.root.find((n: any) => n.type === 'Button' && n.props.testID === 'agent-usage-refresh');
      expect(btn.props.minWidth).toBe(HEIGHT.control);
      expect(btn.props.minHeight).toBe(HEIGHT.control);
      expect(btn.props.alignItems).toBe('flex-start');
      const slot = btn.find((n: any) => n.type === 'YStack' && n.props.height === bodyLine && n.props.justifyContent === 'center');
      expect(slot.findAll((n: any) => n.type === 'Icon.RefreshCw')).toHaveLength(1);
      act(() => btn.props.onPress());
      const spin = tree.root.find((n: any) => n.props?.testID === 'agent-usage-refreshing');
      expect(spin.parent.props).toMatchObject({ width: HEIGHT.control, height: bodyLine, alignItems: 'center', justifyContent: 'center' });
    } finally {
      act(() => tree.unmount());
    }
  });

  it.each(SIZES)('sizes TranscriptCard header slots to max(28, headingLine) when a 28pt identity mark is shown at %s text size', (size) => {
    const expectedSlot = Math.max(28, typeStyle('heading', size).lineHeight);
    const tree = renderAt(
      size,
      <TranscriptCard
        tier="record"
        title="GitHub · Release checks"
        subline="v0.1.249-rc.3 · 3 legs passed"
        alignSublineWithTitle
        stamp="22:09"
        identity={<T v="metaStrong">G</T>}
        onHeaderPress={vi.fn()}
        onDismiss={vi.fn()}
        headerTestID="id-header"
        testID="id-card"
      />,
    );
    try {
      const header = tree.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'id-header');
      const slotBoxes = header.findAll((n: any) => n.type === 'YStack' && n.props.height === expectedSlot && n.props.justifyContent === 'center');
      // identity, stamp, chevron, dismiss glyph
      expect(slotBoxes).toHaveLength(4);
      expect(header.findAll((n: any) => n.type === 'YStack' && n.props.width === 0 && n.props.height === expectedSlot)).toHaveLength(1);
    } finally {
      act(() => tree.unmount());
    }
  });
});
