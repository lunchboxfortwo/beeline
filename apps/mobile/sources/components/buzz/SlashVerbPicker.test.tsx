import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import type { AgentPaletteCommand } from '@/buzz/slash-verbs';
import { availableAgentMentionCommands, insertAgentSlashCommand } from '@/buzz/slash-verbs';
import { SlashVerbPicker } from './SlashVerbPicker';

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

const verbs = [
  {
    id: 'open-corner' as const,
    command: 'open-corner',
    label: 'Open edit corner',
    description: 'Allow the pending repository edit request',
  },
];

const advertisedCommands: AgentPaletteCommand[] = [
  { name: 'loop', description: 'Run again and again' },
  { name: 'review', description: 'Review the diff', inputHint: '[pr-number]' },
];

function find_by_test_id(renderer: ReactTestRenderer, testId: string) {
  // Rows render as Tamagui ListItem hosts; restrict to the host that owns the testID.
  return renderer.root.findAll(
    (node: any) => node.type === 'ListItem' && node.props.testID === testId,
  );
}

describe('SlashVerbPicker agent command palette', () => {
  it('selects the published draw-avatar skill and preserves the exact target mention', () => {
    const onCommand = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [],
        query: 'dra',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: availableAgentMentionCommands(
          [{ name: 'draw-avatar', description: 'Draw from my soul' }],
          'dra',
        ),
        agentName: 'emberus',
        agentLacksCommands: false,
        onSelectCommand: onCommand,
      }),
    );
    const entry = find_by_test_id(renderer, 'slash-agent-command-draw-avatar');
    expect(entry).toHaveLength(1);
    entry[0].props.onPress();
    expect(insertAgentSlashCommand('@emberus /dra', onCommand.mock.calls[0][0])).toBe(
      '@emberus /draw-avatar ',
    );
  });

  it.each(['lo', 'login'])('offers /%s without a profile or harness catalog and preserves the target', (query) => {
    let composer = `@bee /${query}`;
    const renderer = render(React.createElement(SlashVerbPicker, {
      verbs: [], query, highlightedIndex: 0,
      onDismiss: () => undefined, onSelect: () => undefined,
      commands: availableAgentMentionCommands([], query),
      agentName: 'bee', agentLacksCommands: true,
      onSelectCommand: (name: string) => { composer = insertAgentSlashCommand(composer, name); },
    }));
    const login = find_by_test_id(renderer, 'slash-agent-command-login');
    expect(login).toHaveLength(1);
    expect(renderer.root.findAll((node: any) => node.props.testID === 'slash-verb-no-match')).toHaveLength(0);
    login[0].props.onPress();
    expect(composer).toBe('@bee /login ');
    console.log(`Reproduction login-suggestion (shared phone/desktop picker): /lo → login row → ${composer}`);
  });

  it('shows the owner Fast mode as an On/Off switch and selects it by name', () => {
    const onCommand = vi.fn();
    const picker = (enabled: boolean) =>
      render(
        React.createElement(SlashVerbPicker, {
          verbs: [],
          query: 'fa',
          highlightedIndex: 0,
          onDismiss: () => undefined,
          onSelect: () => undefined,
          commands: availableAgentMentionCommands([], 'fa', { enabled }),
          agentName: 'bee',
          agentLacksCommands: true,
          onSelectCommand: onCommand,
        }),
      );
    const stateText = (renderer: ReactTestRenderer) =>
      renderer.root.find(
        (node: any) =>
          node.type === 'Text' && node.props.testID === 'slash-agent-command-fast-mode-state',
      ).props.children;
    const off = picker(false);
    const row = find_by_test_id(off, 'slash-agent-command-fast-mode');
    expect(row).toHaveLength(1);
    expect(row[0].props.accessibilityRole).toBe('switch');
    expect(row[0].props.accessibilityState).toEqual({ selected: true, checked: false });
    expect(stateText(off)).toBe('Off');
    row[0].props.onPress();
    expect(onCommand).toHaveBeenCalledWith('fast-mode');
    expect(stateText(picker(true))).toBe('On');
  });

  it('shows the server restart command and selects it when the harness has no catalog', () => {
    const onCommand = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [],
        query: 'res',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: availableAgentMentionCommands([], 'res'),
        agentName: 'bee',
        agentLacksCommands: true,
        onSelectCommand: onCommand,
      }),
    );
    const restart = find_by_test_id(renderer, 'slash-agent-command-restart');
    expect(restart).toHaveLength(1);
    restart[0].props.onPress();
    expect(onCommand).toHaveBeenCalledWith('restart');
    expect(insertAgentSlashCommand('@bee /res', onCommand.mock.calls[0][0])).toBe('@bee /restart ');
  });

  it('renders ONLY from the published command list handed to it — never a hardcoded inventory', () => {
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [],
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );
    expect(find_by_test_id(renderer, 'slash-agent-command-loop')).toHaveLength(1);
    expect(find_by_test_id(renderer, 'slash-agent-command-review')).toHaveLength(1);
    // No built-in verbs were offered, none are rendered.
    expect(find_by_test_id(renderer, 'slash-verb-open-corner')).toHaveLength(0);
    expect(renderer.root.props.commands).toHaveLength(2);
  });

  it('previews model, usage, status, and permission commands for autocomplete', () => {
    const commands: AgentPaletteCommand[] = [
      { name: 'model', description: 'Show or change the agent model' },
      { name: 'usage', description: 'Show usage status' },
      { name: 'status', inputHint: 'model and account details' },
      { name: 'permissions', description: 'Show permission rules' },
    ];
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [],
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );

    for (const command of commands) {
      expect(find_by_test_id(renderer, `slash-agent-command-${command.name}`)).toHaveLength(1);
    }
  });

  it('selecting an advertised command inserts it via onSelectCommand', () => {
    const onCommand = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: 're',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: onCommand,
      }),
    );
    find_by_test_id(renderer, 'slash-agent-command-review')[0].props.onPress();
    expect(onCommand).toHaveBeenCalledWith('review');
  });

  it('keeps Beeline built-ins selectable alongside the agent commands', () => {
    const onVerb = vi.fn();
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: onVerb,
        commands: advertisedCommands,
        agentName: 'lena',
        agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );
    find_by_test_id(renderer, 'slash-verb-open-corner')[0].props.onPress();
    expect(onVerb).toHaveBeenCalledWith('open-corner');
    for (const id of ['slash-agent-command-loop', 'slash-verb-open-corner']) {
      const row = find_by_test_id(renderer, id)[0];
      expect(row.findAll((node: any) => node.type === 'YStack' && node.props.width === 28)).toHaveLength(0);
      expect(row.findAll((node: any) => node.type === 'Icon.Slash')).toHaveLength(0);
      expect(row.props.paddingHorizontal).toBe('0');
    }
  });

  it('states honestly when the agent does not advertise commands', () => {
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs,
        query: '',
        highlightedIndex: 0,
        onDismiss: () => undefined,
        onSelect: () => undefined,
        commands: [],
        agentName: 'pi runner',
        agentLacksCommands: true,
        onSelectCommand: () => undefined,
      }),
    );
    const noteViews = renderer.root.findAll(
      (node: any) => node.type === 'YStack' && node.props.testID === 'slash-agent-no-commands',
    );
    expect(noteViews).toHaveLength(1);
    // Read `.props.children` directly — JSON.stringify on test-instance props
    // walks the circular Fiber graph.
    const noteLabel = noteViews[0].findByType('Text').props.children as string;
    expect(noteLabel).toBe('pi runner does not advertise commands');
    // And the palette still shows Beeline's built-in verbs.
    expect(find_by_test_id(renderer, 'slash-verb-open-corner')).toHaveLength(1);
  });

  it('lets its scroll give up height above the keyboard so the field stays visible', () => {
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs, query: '', highlightedIndex: 0, onDismiss: () => undefined, onSelect: () => undefined,
        commands: advertisedCommands, agentName: 'lena', agentLacksCommands: false,
        onSelectCommand: () => undefined,
      }),
    );
    const scroll = renderer.root.find(
      (node: any) => node.type === 'ScrollView' && node.props.testID === 'slash-verb-scroll',
    );
    expect(scroll.props.flexShrink).toBe(1);
  });

  function pickerScroll(rowCount: number) {
    const commands = Array.from({ length: rowCount }, (_, i) => ({
      name: `cmd-${i}`,
      description: `Command ${i}`,
    }));
    const renderer = render(
      React.createElement(SlashVerbPicker, {
        verbs: [], query: '', highlightedIndex: 0, onDismiss: () => undefined, onSelect: () => undefined,
        commands, agentName: 'niglet', agentLacksCommands: false, onSelectCommand: () => undefined,
      }),
    );
    const scroll = () =>
      renderer.root.find(
        (node: any) => node.type === 'ScrollView' && node.props.testID === 'slash-verb-scroll',
      );
    const measure = (viewport: number, content: number) =>
      act(() => {
        scroll().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: viewport } } });
        scroll().props.onContentSizeChange(360, content);
      });
    return { scroll, measure };
  }

  it('draws no bottom fade and does not scroll when one command fits', () => {
    const { scroll, measure } = pickerScroll(1);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 0 });
    expect(scroll().props.scrollEnabled).toBe(false);
    measure(56, 56);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 0 });
    expect(scroll().props.scrollEnabled).toBe(false);
  });

  it('keeps the bottom fade while a list of more than six rows can scroll', () => {
    const { scroll, measure } = pickerScroll(8);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 48 });
    expect(scroll().props.scrollEnabled).toBe(true);
    measure(6 * 56, 8 * 56);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 48 });
    expect(scroll().props.scrollEnabled).toBe(true);
  });

  it('fades a short list once the keyboard squeezes it below its rows', () => {
    const { scroll, measure } = pickerScroll(3);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 0 });
    measure(100, 3 * 56);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 48 });
    expect(scroll().props.scrollEnabled).toBe(true);
  });

  it('ignores a sliver of overflow so one squeezed row stays crisp', () => {
    const { scroll, measure } = pickerScroll(1);
    measure(52, 56);
    expect(scroll().props.fadingEdgeLength).toEqual({ start: 0, end: 0 });
    expect(scroll().props.scrollEnabled).toBe(false);
  });
});
