import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({ theme: { buzz: {} } }),
}));
vi.mock('./Ledger', () => ({ ledgerEntryRhythm: () => ({}), LedgerSystemLine: () => null }));
vi.mock('./Ledger-styles', () => ({ settledAgentProseStyle: () => ({}) }));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: () => null }));
vi.mock('@/ui/screens/transcript/PillRow', () => ({ PillRow: () => <React.Fragment /> }));
vi.mock('./CornerGlyph', () => ({ CornerGlyph: () => null, CORNER_META_SIZE: 14 }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: () => null, CHEVRON_ROW_SIZE: 14 }));
vi.mock('./IndexRow', () => ({
  InlineRow: ({ children }: any) => <>{children}</>,
  TranscriptNavigationRow: ({ children, primary, trailing, testID }: any) => React.createElement('Pressable', {
    testID, onPress: primary?.onPress ?? trailing?.onPress,
  }, children),
}));

import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import { foldPillRuns } from '@/buzz/transcript-pills';
import { TranscriptPills } from './TranscriptPills';

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
  const control = (id: string) => tree.root.find((node: any) => node.type === 'Pressable' && node.props.testID === id);
  expect(control('notification-run-expand-merge-0').props.accessibilityLabel).toBe('14 PRs merged');
  act(() => control('notification-run-expand-merge-0').props.onPress());
  expect(control('notification-run-more-merge-0').props.accessibilityLabel).toBe('12 more events');
  act(() => control('notification-run-more-merge-0').props.onPress());
  for (const [index, event] of events.entries()) {
    const row = control(`notification-run-cell-${event.id}`);
    const copy = row.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children).flat();
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
