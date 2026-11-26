import * as React from 'react';
vi.mock('expo-font', () => ({ useFonts: vi.fn(() => [true, null]) }));
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    PixelRatio: { get: () => 1 },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

vi.mock('tamagui', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(),
);
vi.mock('lucide-react-native', async () =>
  (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts(),
);
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('./Button', () => ({
  Button: (props: any) => React.createElement('Button', props, props.label),
}));
vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn().mockResolvedValue(undefined),
}));

import * as Clipboard from 'expo-clipboard';
import { ToolOutputSheet } from './ToolOutputSheet';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const treeText = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe('ToolOutputSheet (v3 result-first)', () => {
  it('renders 32261.jpg fenced flat JSON as a kv-card and folds Raw command & JSON in footer', () => {
    const fencedJson = [
      '```console',
      JSON.stringify(
        {
          date: '2026-11-25',
          last7: { start: '2026-11-18', end: '2026-11-24' },
          status: 'ok',
          account: { id: '18ce55ws4zb', name: 'Beeline (@usebeelineapp)' },
          sourceUrl: 'https://ads.x.com/manager/18ce55ws4zb/campaigns?tab=campaigns',
          yesterdayRows: [],
          yesterdayTotals: { spend: 0, impressions: 0 },
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Inspected X Ads summary"
        command={`cd ~/x-ads; head -c 3500 2026-11-25.json`}
        detail={fencedJson}
        rawOutput={fencedJson}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-kv-card' })).toBeTruthy();
    const initial = treeText(renderer);
    expect(initial).toContain('2026-11-25');
    expect(initial).toContain('Last 7');
    expect(initial).toContain('Beeline (@usebeelineapp)');
    expect(initial).toContain('?tab=campaigns');
    expect(initial).not.toContain('```console');
    expect(renderer.root.findAllByProps({ testID: 'tool-output-raw-panel' })).toHaveLength(0);

    act(() => renderer.root.findByProps({ testID: 'tool-output-raw-toggle' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'tool-output-raw-panel' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'tool-output-command' })).toBeTruthy();
  });

  it('renders 32263.jpg empty tools JSON as an empty-banner with query chips and humanized Squire title', () => {
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Searched Trusty Squire tools"
        input={JSON.stringify({
          app: 'registry-mcp:squire',
          query: 'operate_drive operate_finish use_credential',
        })}
        detail='{"tools": []}'
        rawOutput='{"tools": []}'
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-empty' })).toBeTruthy();
    const text = treeText(renderer);
    expect(text).toContain('No matching tools returned');
    expect(text).toContain('operate_drive');
    expect(text).toContain('operate_finish');
    expect(text).toContain('use_credential');
    expect(renderer.root.findByType('HullActionSheetModal').props.title).toBe(
      'Searched Trusty Squire tools',
    );
  });

  it('renders JSON arrays as stacked item cards with Bounded badge and _omittedCount note', () => {
    const payload = JSON.stringify({
      schedules: [
        {
          scheduleId: 's1',
          title: 'Morning card',
          paused: false,
          roomName: '#beeline',
          repliesTo: { handle: 'lunchboxfortwo' },
        },
        {
          scheduleId: 's2',
          title: 'Nightly production release',
          paused: false,
          roomName: '#release-corner',
        },
      ],
      _omittedCount: 6,
    });
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Listed schedules"
        detail={payload}
        rawOutput={payload}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-badge' }).findByType('Text').props.children).toBe(
      'Bounded',
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-array-cards' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'tool-output-card-0' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'tool-output-card-1' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'tool-output-omitted-note' }).props.children).toBe(
      '+ 6 more schedules omitted at the 4 KiB step cap',
    );
    expect(treeText(renderer)).not.toContain('schedule id');
  });

  it('recovers partial top-level fields from truncated >4 KiB JSON and displays Truncated badge', () => {
    const truncated =
      '{"date": "2026-11-25", "status": "ok", "yesterdayRows": [], "yesterdayTotals": {"spend": 0';
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Inspected JSON"
        detail={truncated}
        rawOutput={truncated}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-badge' }).findByType('Text').props.children).toBe(
      'Truncated',
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-kv-card' })).toBeTruthy();
    expect(treeText(renderer)).toContain('2026-11-25');
  });

  it('renders file edit unified diffs with added/removed tokens and Raw patch footer', () => {
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Edited room-turn-steps.ts"
        files={[
          {
            path: 'apps/body/src/room-turn-steps.ts',
            status: 'M',
            diff: "@@ -28,2 +28,3 @@\n   'toolSummary',\n-  'state',\n+  'state',\n+  'app',",
          },
        ]}
        detail=""
      />,
    );
    const diff = renderer.root.findByProps({ testID: 'tool-output-diff' });
    const texts = diff.findAllByType('Text');
    expect(texts.some((n: any) => n.props.color === 'added' && String(n.props.children).includes("'app'"))).toBe(true);
    expect(texts.some((n: any) => n.props.color === 'removed' && String(n.props.children).includes("-  'state'"))).toBe(true);
    expect(treeText(renderer)).toContain('Raw patch');
  });

  it('renders TodoWrite / ACP plan checklists and supports Copy raw', async () => {
    const renderer = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Updated plan"
        plan={{
          objective: 'Ship v3 ledger',
          items: [
            { step: 'Fix wire guard', status: 'completed' },
            { step: 'Build result-first sheet', status: 'in_progress' },
            { step: 'Capture proofs', status: 'pending' },
          ],
        }}
        detail='{"todos":[]}'
        rawOutput='{"todos":[]}'
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-output-checklist' })).toBeTruthy();
    expect(treeText(renderer)).toContain('Fix wire guard');
    expect(treeText(renderer)).toContain('Build result-first sheet');
    await act(async () => {
      await renderer.root.findByProps({ testID: 'tool-output-copy' }).props.onPress();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalled();
  });

  it('shows Failed with no output on empty failures and hides Raw/Copy on secret outputs', () => {
    const failedEmpty = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Run script"
        outcome="failure"
        detail=""
      />,
    );
    expect(failedEmpty.root.findByProps({ testID: 'tool-output-text' }).props.children).toBe(
      'Failed with no output',
    );

    const secret = render(
      <ToolOutputSheet
        visible
        onClose={() => undefined}
        title="Read .env"
        outputHidden
        detail="Output hidden: contains a secret."
      />,
    );
    expect(secret.root.findByProps({ testID: 'tool-output-secret' })).toBeTruthy();
    expect(secret.root.findAllByProps({ testID: 'tool-output-copy' })).toHaveLength(0);
    expect(secret.root.findAllByProps({ testID: 'tool-output-raw-toggle' })).toHaveLength(0);
  });
});
