import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkBoardView } from '@beeline/api-contract/phone';

vi.mock('react-native', () => ({
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
        headerTestID="multi-header"
      />,
    );
    try {
      const headerButton = multi.root.find((n: any) => n.type === 'ListItem' && n.props.testID === 'multi-header');
      const headRow = headerButton.find((n: any) => n.type === 'XStack' && n.props.flex === 1);
      expect(headRow.props.alignItems).toBe('flex-start');
      const headerLineWrappers = headRow.findAll(
        (n: any) => n.type === 'YStack' && n.props.height === headingLine && n.props.justifyContent === 'center',
      );
      expect(headerLineWrappers).toHaveLength(2);
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
    const optionTree = renderAt('medium', <ChoiceOption choice={choice} closed />);
    try {
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
});
