import * as React from 'react';
vi.mock('expo-font', () => ({ useFonts: vi.fn(() => [true, null]) }));
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const toolReader = vi.fn();
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: (...args: unknown[]) => toolReader(...args),
}));

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
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props, props.markdown),
}));
vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('./Button', () => ({
  Button: (props: any) => React.createElement('Button', props, props.label),
}));
vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props, props.label),
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
    },
    Easing: { linear: (t: number) => t },
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value,
  };
});
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn().mockResolvedValue(undefined),
}));

import { TurnStepsLine } from './ActivityTimeline';

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

const renderedText = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

function expandRun(renderer: ReactTestRenderer, id: string): void {
  act(() => renderer.root.findByProps({ testID: `tool-run-group-${id}` }).props.onPress());
}

describe('universal ACP twin-item fetch & missing-item handling', () => {
  it('matches same-message twin items by itemIndex, keeps path-only twin non-tappable, carries new fields, and handles missing-item response', async () => {
    toolReader.mockReset();
    const roomId = '22222222-2222-4222-8222-222222222222';
    const anchor = 'e'.repeat(64);
    const author = { pubkey: 'b'.repeat(64), kind: 'agent' as const, name: 'Worker' };
    const listMessage = {
      id: anchor,
      text: '',
      createdAt: 1,
      presentation: 'activity' as const,
      author,
      activity: [
        {
          kind: 'tool' as const,
          title: 'ChatTree.tsx',
          operation: 'read',
          status: 'completed',
          files: [{ path: 'ui/screens/chats/ChatTree.tsx', line: 114, endLine: 145 }],
          hasDetail: false,
        },
        {
          kind: 'tool' as const,
          title: 'ChatTree.tsx',
          operation: 'edit',
          status: 'completed',
          origin: { kind: 'subagent' as const, label: 'researcher' },
          files: [{ path: 'ui/screens/chats/ChatTree.tsx', status: 'M', addedLines: 6, removedLines: 3 }],
          hasDetail: true,
          toolOutput: { roomId, anchor, messageId: anchor, itemIndex: 1, hasDetail: true },
        },
      ],
    };

    toolReader.mockResolvedValueOnce({ roomId, messages: [listMessage] });
    const renderer = render(
      <TurnStepsLine
        items={[{ kind: 'tool', id: 'agg', title: '2 steps', toolGroup: { roomId, anchor, count: 2 } }]}
      />,
    );
    await act(async () => expandRun(renderer, 'agg'));

    // Twin #0 (path-only) has NO chevron / NO onPress
    const twin0 = renderer.root.findByProps({ testID: `tool-ledger-line-${anchor}:0` });
    expect(twin0.findAll((n: any) => typeof n.props?.onPress === 'function')).toHaveLength(0);
    expect(twin0.findAll((n: any) => n.props?.direction === 'right')).toHaveLength(0);

    // Twin #1 (diff) shows subagent origin + exact +6 -3 + chevron
    const twin1 = renderer.root.findByProps({ testID: `tool-ledger-line-${anchor}:1` });
    expect(renderedText(renderer)).toContain('subagent · researcher');
    expect(renderedText(renderer)).toContain('+6');
    expect(renderedText(renderer)).toContain('-3');

    // Tap twin #1 -> full message returned -> matches itemIndex 1 and renders its diff
    toolReader.mockResolvedValueOnce({
      roomId,
      messages: [
        {
          ...listMessage,
          activity: [
            listMessage.activity[0]!,
            {
              ...listMessage.activity[1]!,
              files: [
                {
                  path: 'ui/screens/chats/ChatTree.tsx',
                  status: 'M',
                  addedLines: 6,
                  removedLines: 3,
                  diff: '@@ -1,2 +1,2 @@\n-old\n+new',
                },
              ],
            },
          ],
        },
      ],
    });
    const twin1Press = twin1.findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    await act(async () => twin1Press.props.onPress());
    expect(renderer.root.findByProps({ testID: 'tool-output-diff' })).toBeTruthy();

    // Missing-item response -> shows honest missing error instead of wrong sibling
    toolReader.mockResolvedValueOnce({ roomId, messages: [] });
    await act(async () => twin1Press.props.onPress());
    expect(renderedText(renderer)).toContain('no longer available');

    await act(async () => renderer.unmount());
  });

  it('opens a clipped-summary row and renders the full restored summary in the sheet when it is the only unseen detail', async () => {
    toolReader.mockReset();
    const roomId = '22222222-2222-4222-8222-222222222222';
    const anchor = 'f'.repeat(64);
    const author = { pubkey: 'b'.repeat(64), kind: 'agent' as const, name: 'Worker' };
    const fullSummary = `Checked repository status and summarized findings ${'s'.repeat(210)} END_RESTORED_SUMMARY`;
    const clippedSummary = fullSummary.slice(0, 200);
    const listMessage = {
      id: anchor,
      text: '',
      createdAt: 1,
      presentation: 'activity' as const,
      author,
      activity: [
        {
          kind: 'tool' as const,
          title: 'Summary clipped',
          status: 'completed',
          summary: clippedSummary,
          hasDetail: true,
          toolOutput: { roomId, anchor, messageId: anchor, itemIndex: 0, hasDetail: true },
        },
      ],
    };

    toolReader.mockResolvedValueOnce({ roomId, messages: [listMessage] });
    const renderer = render(
      <TurnStepsLine
        items={[{ kind: 'tool', id: 'agg-summary', title: '1 step', toolGroup: { roomId, anchor, count: 1 } }]}
      />,
    );
    await act(async () => expandRun(renderer, 'agg-summary'));

    const row = renderer.root.findByProps({ testID: `tool-ledger-line-${anchor}:0` });
    const pressable = row.findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    expect(pressable).toBeTruthy();

    toolReader.mockResolvedValueOnce({
      roomId,
      messages: [
        {
          ...listMessage,
          activity: [
            {
              kind: 'tool' as const,
              title: 'Summary clipped',
              status: 'completed',
              summary: fullSummary,
            },
          ],
        },
      ],
    });
    await act(async () => pressable.props.onPress());

    const caption = renderer.root.findByProps({ testID: 'tool-output-caption-0' });
    expect(caption.props.children).toBe(fullSummary);
    expect(renderedText(renderer)).toContain('END_RESTORED_SUMMARY');
    expect(renderedText(renderer)).not.toContain('No output captured for this step.');

    await act(async () => renderer.unmount());
  });

  it('preserves a recorded failure in the collapsed summary across partial remote pagination pages and folds loaded consecutive reads', async () => {
    toolReader.mockReset();
    const roomId = '22222222-2222-4222-8222-222222222222';
    const anchor = 'a'.repeat(64);
    const page2Anchor = 'b'.repeat(64);
    const author = { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Worker' };

    const page1 = {
      roomId,
      next: 'cursor-page-2',
      messages: [
        {
          id: anchor,
          text: '',
          createdAt: 1,
          presentation: 'activity' as const,
          author,
          activity: [
            {
              kind: 'tool' as const,
              title: 'Read',
              operation: 'read',
              status: 'completed',
              files: [{ path: 'apps/mobile/sources/components/buzz/ThreadHeader.tsx' }],
            },
            {
              kind: 'tool' as const,
              title: 'Read',
              operation: 'read',
              status: 'completed',
              files: [{ path: 'apps/mobile/sources/components/buzz/ChevronGlyph.tsx' }],
            },
          ],
        },
      ],
    };

    const page2 = {
      roomId,
      messages: [
        {
          id: page2Anchor,
          text: '',
          createdAt: 2,
          presentation: 'activity' as const,
          author,
          activity: [
            {
              kind: 'tool' as const,
              title: 'Bash',
              operation: 'execute',
              command: 'vitest run sources/buzz/alignment',
              status: 'failed',
              exitCode: 1,
              output: "Cannot find package 'vitest'",
            },
          ],
        },
      ],
    };

    toolReader.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const renderer = render(
      <TurnStepsLine
        items={[
          {
            kind: 'tool',
            id: 'agg-fail',
            title: '3 steps',
            status: 'failed',
            toolGroup: { roomId, anchor, count: 3 },
          },
        ]}
      />,
    );

    // Before fetch: unloaded remote placeholder shows honest Steps + recorded failure.
    expect(renderer.root.findByProps({ testID: 'tool-run-group-agg-fail' }).props.accessibilityLabel).toBe(
      'Steps · 1 failed, expandable',
    );

    // After page 1 loads 2 passing reads with more pages remaining: recorded failure stays visible
    // and consecutive loaded reads fold into one Checked row.
    await act(async () => expandRun(renderer, 'agg-fail'));
    expect(renderer.root.findByProps({ testID: 'tool-run-group-agg-fail' }).props.accessibilityLabel).toBe(
      'Checked files · 1 failed, expandable',
    );
    expect(
      renderer.root.findByProps({ testID: `tool-read-fold-read-fold-${anchor}:0` }),
    ).toBeTruthy();

    // After page 2 loads the actual failed test step (no more remote pages): summary upgrades cleanly.
    await act(async () =>
      renderer.root.findByProps({ testID: 'tool-run-more-agg-fail' }).props.onPress(),
    );
    expect(renderer.root.findByProps({ testID: 'tool-run-group-agg-fail' }).props.accessibilityLabel).toBe(
      'Ran tests · 1 failed, expandable',
    );

    await act(async () => renderer.unmount());
  });
});
