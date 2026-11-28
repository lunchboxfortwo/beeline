import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/components/buzz/IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));

import { STEP, ThreadGlyph, type Step } from '@/ui/grammar';
import { TranscriptLine } from '@/ui/screens/transcript/TranscriptLine';
import { RepositoryLifecycleRow } from './PrLifecycleCard';
import { DaemonFactCard } from './LifecycleCard';
import { TranscriptActionLead } from './TranscriptActionLead';

/** The thread glyph's box, in its own units. */
const GLYPH_BOX_UNITS = 24;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

function render(element: React.ReactElement) {
  let tree: any;
  act(() => {
    tree = create(element);
  });
  return tree;
}

/** Resolves a space step; the grammar's steps at Medium are Tamagui's space tokens. */
function space(value: unknown): number {
  if (typeof value === 'number') return value;
  const resolved = STEP[String(value).replace(/^\$/, '') as Step];
  if (typeof resolved !== 'number') throw new Error(`unknown space step ${String(value)}`);
  return resolved;
}

/** The nearest host ancestor of a given type. */
function closest(node: any, type: unknown) {
  let at = node.parent;
  while (at && at.type !== type) at = at.parent;
  if (!at) throw new Error(`no ${String(type)} ancestor`);
  return at;
}

/** The face center and text column of a message, from the row's own left edge. */
function messageColumns() {
  const tree = render(
    <TranscriptLine sender={{ name: 'Crayon', stamp: '09:26', mark: { seed: 'crayon', kind: 'agent' } }}>
      body
    </TranscriptLine>,
  );
  try {
    const line = tree.root.find((n: any) => n.type === 'XStack' && n.props.width === '100%');
    const face = line.find((n: any) => n.type === 'IdentityMark');
    const faceColumn = closest(face, 'YStack');
    // The face sits at the left of its column, and the text column follows it.
    expect(faceColumn.props.alignItems).toBe('flex-start');
    return {
      faceCenter: face.props.size / 2,
      textColumn: faceColumn.props.width + space(line.props.gap),
    };
  } finally {
    act(() => tree.unmount());
  }
}

/** The stem x and label x of a navigation row, from the row's own left edge. */
function rowColumns(tree: any, rowTestID: string) {
  const target = tree.root.find((n: any) => n.props.testID === rowTestID && typeof n.type === 'string');
  const slot = target.find((n: any) => n.type === 'YStack' && n.props.testID === 'transcript-action-lead');
  const row = closest(slot, 'XStack');
  const glyph = slot.find((n: any) => n.type === ThreadGlyph);
  // The stem is the vertical line the glyph's second path starts with.
  const stem = glyph.findAll((n: any) => typeof n.props.d === 'string' && /^M[\d.]+ [\d.]+v/.test(n.props.d));
  const stemUnits = Number(stem[0].props.d.match(/^M([\d.]+)/)![1]);
  // The slot starts its box at the row's left edge; the box ends the glyph on its right edge.
  const box = slot.find((n: any) => n.type === 'YStack' && n.props.testID === 'transcript-action-lead-stem');
  expect(slot.props.alignItems).toBe('flex-start');
  expect(box.props.alignItems).toBe('flex-end');
  return {
    slot,
    glyph,
    stemX: box.props.width - glyph.props.size + (glyph.props.size * stemUnits) / GLYPH_BOX_UNITS,
    labelX: slot.props.width + space(row.props.gap),
  };
}

function cornerRow() {
  return render(
    <RepositoryLifecycleRow
      item={{
        id: 'c1',
        kind: 'corner',
        state: 'Opened',
        title: 'declarative-app-corpus',
        kindLine: 'thread',
        cornerId: 'corner-1',
        actor: 'crayon',
        updatedBy: 'c1',
      }}
      onOpenCorner={vi.fn()}
      onOpenUrl={vi.fn()}
    />,
  );
}

function backlogRow(onOpenBacklog?: (roomId: string) => void) {
  const message = {
    id: 'b1',
    timestamp: 0,
    daemonFact: { type: 'backlog-added', roomId: 'room-1', items: [{ name: 'await-runner-teardown' }, { name: 'second' }] },
  } as any;
  return render(
    <DaemonFactCard message={message} onOpenCorner={vi.fn()} onOpenUrl={vi.fn()} onOpenBacklog={onOpenBacklog} />,
  );
}

describe('TranscriptActionLead', () => {
  it('puts the opened-thread glyph stem on the message face center', () => {
    const { faceCenter } = messageColumns();
    const tree = cornerRow();
    try {
      const { stemX } = rowColumns(tree, 'notification-run-cell-c1');
      expect(Math.abs(stemX - faceCenter)).toBeLessThanOrEqual(1);
    } finally {
      act(() => tree.unmount());
    }
  });

  it('gives the added-to-backlog row the same glyph at the same offset', () => {
    const corner = cornerRow();
    const linked = backlogRow(vi.fn());
    const plain = backlogRow();
    try {
      const a = rowColumns(corner, 'notification-run-cell-c1');
      for (const tree of [linked, plain]) {
        const b = rowColumns(tree, 'backlog-added-row-b1');
        const { children: _a, ...slotA } = a.slot.props;
        const { children: _b, ...slotB } = b.slot.props;
        expect(closest(b.slot, TranscriptActionLead)).toBeTruthy();
        expect(closest(a.slot, TranscriptActionLead)).toBeTruthy();
        expect(slotB).toEqual(slotA);
        expect(b.glyph.props).toEqual(a.glyph.props);
        expect(b.stemX).toBe(a.stemX);
        expect(b.labelX).toBe(a.labelX);
      }
      // Size, stroke and color are unchanged.
      expect(a.glyph.props).toMatchObject({ size: 13, strokeWidth: 1.7 });
    } finally {
      act(() => corner.unmount());
      act(() => linked.unmount());
      act(() => plain.unmount());
    }
  });

  it('starts both labels on the message text column', () => {
    const { textColumn } = messageColumns();
    const corner = cornerRow();
    const backlog = backlogRow(vi.fn());
    try {
      expect(rowColumns(corner, 'notification-run-cell-c1').labelX).toBe(textColumn);
      expect(rowColumns(backlog, 'backlog-added-row-b1').labelX).toBe(textColumn);
    } finally {
      act(() => corner.unmount());
      act(() => backlog.unmount());
    }
  });
});
