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

describe('Reproduction tool-ledger-32233', () => {
  const ITEMS_32233 = [
    {
      kind: 'tool' as const,
      id: 'boot-warn',
      title: 'codex-acp',
      toolKind: 'other',
      status: 'failed',
      output: '[codex-acp forwarded startup stderr] optional mcp server timed out',
    },
    {
      kind: 'tool' as const,
      id: 'read-skill',
      title: 'Read /home/lunchbox/skills/waiting-and-wakes/SKILL.md',
      toolKind: 'read',
      files: [{ path: '/home/lunchbox/skills/waiting-and-wakes/SKILL.md' }],
      status: 'completed',
      output: '# Waiting and wakes',
    },
    {
      kind: 'tool' as const,
      id: 'rg-1',
      title: 'exec_command',
      toolKind: 'execute',
      command: `bash -lc 'cd /repo && rg -n "schedule" apps/server/src'`,
      status: 'completed',
      output: 'apps/server/src/wake.ts:14:export function listSchedules()',
    },
    {
      kind: 'tool' as const,
      id: 'wake-list',
      title: 'mcp.beeline-agent.wake',
      toolKind: 'other',
      input: JSON.stringify({ action: 'list' }),
      status: 'completed',
      output: '{"schedules":[{"title":"Morning card"}]}',
    },
    {
      kind: 'tool' as const,
      id: 'cat-1',
      title: 'exec_command',
      toolKind: 'execute',
      command: 'cat apps/server/src/index.ts',
      status: 'completed',
      output: 'export {}',
    },
    {
      kind: 'tool' as const,
      id: 'rg-2',
      title: 'exec_command',
      toolKind: 'execute',
      command: 'rg -n "repliesTo" apps/server/src',
      status: 'completed',
      output: 'no matches',
    },
  ];

  it('demotes startup warning, renders flat single-item rows without observation sub-folders, and puts Raw arguments behind toggle', () => {
    const renderer = render(<TurnStepsLine items={ITEMS_32233} />);
    const group = renderer.root.findByProps({ testID: 'tool-run-group-boot-warn' });
    expect(group.props.accessibilityLabel).toBe('5 steps, expandable');
    expect(renderedText(renderer)).not.toContain('failed');

    expandRun(renderer, 'boot-warn');
    const expandedText = renderedText(renderer);
    expect(expandedText).toContain('Startup note');
    expect(expandedText).not.toContain('Action failed');
    expect(expandedText).not.toContain('the code');
    expect(expandedText).not.toContain('a file');
    expect(expandedText).not.toContain('mcp.beeline-agent.wake');
    expect(
      renderer.root.findAllByProps({ testID: 'tool-observation-fold-obs-read-skill' }),
    ).toHaveLength(0);
    expect(expandedText).toContain('waiting-and-wakes/SKILL.md');
    expect(
      renderer.root
        .findByProps({ testID: 'tool-ledger-line-rg-1' })
        .findAllByType('Text')
        .map((n: any) => n.props.children),
    ).toContain('rg -n "schedule" apps/server/src');
    expect(expandedText).toContain('Listed');
    expect(expandedText).toContain('schedules');

    const wakePress = renderer.root
      .findByProps({ testID: 'tool-ledger-line-wake-list' })
      .findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    act(() => wakePress.props.onPress());
    expect(renderer.root.findByProps({ testID: 'tool-output-array-cards' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'tool-output-input' })).toHaveLength(0);
    act(() => renderer.root.findByProps({ testID: 'tool-output-raw-toggle' }).props.onPress());
    const inputBlock = renderer.root.findByProps({ testID: 'tool-output-input' });
    expect(inputBlock).toBeTruthy();
    expect(inputBlock.findAllByType('Text').map((n: any) => n.props.children).join('\n')).toContain(
      '"action": "list"',
    );
  });

  it('keeps Failed intact on line one with flexShrink=0 and places the failure reason on line two', () => {
    const renderer = render(
      <TurnStepsLine
        items={[
          {
            kind: 'tool',
            id: 'real-fail',
            title: 'exec_command',
            toolKind: 'execute',
            command: 'npm run typecheck --workspace apps/server',
            status: 'failed',
            output: 'src/index.ts(12,5): error TS2322: Type string is not assignable to number',
          },
        ]}
      />,
    );
    expandRun(renderer, 'real-fail');
    const row = renderer.root.findByProps({ testID: 'tool-ledger-line-real-fail' });
    const failedText = row
      .findAllByType('Text')
      .find((node: any) => node.props.children === 'Failed');
    expect(failedText.props.flexShrink).toBe(0);
    expect(failedText.props.numberOfLines).toBe(1);
    const reason = renderer.root.findByProps({ testID: 'activity-reason-real-fail' });
    expect(reason.props.children).toContain('error TS2322');
    // Line 1 XStack does not contain the reason node; reason sits on its own second line.
    expect(reason.parent.type).toBe('YStack');
  });

  it('keeps multiline mutating commands visible and preserves newlines in ToolOutputSheet Raw panel', () => {
    const renderer = render(
      <TurnStepsLine
        items={[
          {
            kind: 'tool',
            id: 'read-1',
            title: 'Read',
            toolKind: 'read',
            files: [{ path: 'apps/server/src/index.ts' }],
            status: 'completed',
          },
          {
            kind: 'tool',
            id: 'multi-write',
            title: 'exec_command',
            toolKind: 'execute',
            command: 'ls\nmkdir scratch',
            status: 'completed',
            output: 'created scratch',
          },
        ]}
      />,
    );
    expandRun(renderer, 'read-1');
    const row = renderer.root.findByProps({ testID: 'tool-ledger-line-multi-write' });
    expect(row.findAllByType('Text').map((n: any) => n.props.children)).toContain(
      'ls; mkdir scratch',
    );
    const rowPress = row.findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    act(() => rowPress.props.onPress());
    act(() => renderer.root.findByProps({ testID: 'tool-output-raw-toggle' }).props.onPress());
    const commandBlock = renderer.root.findByProps({ testID: 'tool-output-command' });
    expect(commandBlock.findAllByType('Text').map((n: any) => n.props.children)).toContain(
      'ls\nmkdir scratch',
    );
  });

  it('surfaces structured beeline-agent receipts on step rows and renders kv-card plus Receipt in ToolOutputSheet', () => {
    const receipt = 'Updated "Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo';
    const renderer = render(
      <TurnStepsLine
        items={[
          {
            kind: 'tool',
            id: 'wake-upd',
            title: 'mcp.beeline-agent.wake',
            toolKind: 'other',
            status: 'completed',
            input: JSON.stringify({ action: 'update', trigger: 'schedule', scheduleId: 's1' }),
            output: JSON.stringify({
              scheduleId: 's1',
              receipt,
              repliesTo: { identityId: 'u1', handle: 'lunchboxfortwo' },
              approvedBy: { identityId: 'u1', handle: 'lunchboxfortwo', sourceMessageId: 'm1' },
            }),
          },
        ]}
      />,
    );
    expandRun(renderer, 'wake-upd');
    const row = renderer.root.findByProps({ testID: 'tool-ledger-line-wake-upd' });
    const rowTexts = row.findAllByType('Text').map((n: any) => n.props.children);
    expect(rowTexts).toContain('Updated');
    expect(rowTexts.join(' ')).toContain('Morning card');
    expect(rowTexts.join(' ')).toContain('replies to @lunchboxfortwo');

    const rowPress = row.findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    act(() => rowPress.props.onPress());
    const receiptBlock = renderer.root.findByProps({ testID: 'tool-output-receipt' });
    expect(receiptBlock.findAllByType('Text').map((n: any) => n.props.children)).toContain(receipt);
    const sheetText = renderedText(renderer);
    expect(sheetText).not.toContain('No output saved');
    expect(sheetText).toContain('lunchboxfortwo');
  });

  it('resolves 32269.jpg handoff names, kills duplicate trigger prose, and opens sent message card', () => {
    const crayonHex = '784c9656dbf5b4ca97f1ffc471981766a88e86ae2c965df213c6bbe1421146f4';
    const threadUuid = 'b71a2a24-3d77-4b74-abb9-d6584d6fa119';
    const renderer = render(
      <TurnStepsLine
        lookup={{
          participants: [{ pubkey: crayonHex, handle: 'crayon', name: 'Crayon' }],
          channelIndex: {
            rooms: [{ channelId: '11111111-1111-4111-8111-111111111111', name: 'beeline' }],
            corners: [
              {
                channelId: threadUuid,
                parentChannelId: '11111111-1111-4111-8111-111111111111',
                name: 'helper-index-flake',
                roomName: 'beeline',
              },
            ],
          },
          speakerName: 'Ruby',
        }}
        items={[
          {
            kind: 'tool',
            id: 'handoff-1',
            title: 'mcp__beeline-agent__message',
            toolKind: 'other',
            status: 'completed',
            input: JSON.stringify({
              type: 'normal',
              address: `${crayonHex}@${threadUuid}`,
              text: 'Write the read-only snapshot to its own file before pushing for Speedy.',
            }),
            output: JSON.stringify({ queued: true }),
          },
        ]}
      />,
    );
    const trigger = renderer.root.findByProps({ testID: 'tool-run-group-handoff-1' });
    expect(trigger.props.accessibilityLabel).toBe('1 step, expandable');
    expect(renderedText(renderer)).not.toContain('784c96');
    expect(renderedText(renderer)).not.toContain('b71a2a24');

    expandRun(renderer, 'handoff-1');
    const openText = renderedText(renderer);
    expect(openText).toContain('@crayon');
    expect(openText).toContain('#helper-index-flake');
    expect(openText).not.toContain('784c96');

    const rowPress = renderer.root
      .findByProps({ testID: 'tool-ledger-line-handoff-1' })
      .findAll((n: any) => n.type === 'XStack' && typeof n.props.onPress === 'function')[0];
    act(() => rowPress.props.onPress());
    const card = renderer.root.findByProps({ testID: 'tool-output-sent-message' });
    expect(card).toBeTruthy();
    expect(renderedText(renderer)).toContain('Ruby → Crayon');
    expect(renderedText(renderer)).toContain('Write the read-only snapshot to its own file');
  });
});
