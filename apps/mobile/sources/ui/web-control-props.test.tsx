// @vitest-environment jsdom
import React, { act } from 'react';
// @ts-expect-error react-dom has no client declarations in this workspace.
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TamaguiProvider } from 'tamagui';
import { MessageReactionRoster } from '@/components/buzz/MessageReactionRoster';
import { TurnProgressLine } from '@/components/buzz/TurnProgressLine';
import { WebAlertModal } from '@/modal/components/WebAlertModal';
import { WebPromptModal } from '@/modal/components/WebPromptModal';
import { REPORT_ISSUE_PROMPT } from '@/buzz/report-message-issue';
import { tamaguiConfig } from './tamagui.config';

vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
  Keyboard: { dismiss() {} },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
  Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible === false ? null : children,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, flatten: (style: unknown) => style },
  Pressable: (props: { children?: React.ReactNode }) => React.createElement('div', props, props.children),
  View: (props: { children?: React.ReactNode }) => React.createElement('div', props, props.children),
  Text: (props: { children?: React.ReactNode }) => React.createElement('span', props, props.children),
  TextInput: (props: Record<string, unknown>) => React.createElement('input', props),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The icon barrel is a native module. Loading it pulls the real react-native
// entry, which Node cannot parse. These tests only need the icons to exist.
vi.mock('lucide-react-native', () => {
  const icon = (props: { children?: React.ReactNode }) => React.createElement('i', props, props.children);
  return { ArrowLeft: icon, Check: icon, ChevronRight: icon, Copy: icon, Hash: icon };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// jsdom has no Web Animations API. The thinking spinner calls it on mount.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Object.assign(Element.prototype, { animate: () => ({ cancel() {} }) });
}

type MountedRoot = { render(node: React.ReactNode): void; unmount(): void };
const roots: MountedRoot[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host) as MountedRoot;
  roots.push(root);
  act(() => {
    root.render(<TamaguiProvider config={tamaguiConfig} defaultTheme="light">{node}</TamaguiProvider>);
  });
  return host;
}

/** The name a browser accessibility tree would report for this node. */
function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function expectButton(host: ParentNode, name: string) {
  const buttons = [...host.querySelectorAll('[role="button"]')];
  const match = buttons.find((element) => accessibleName(element) === name);
  expect(match, `button named ${name}`).toBeTruthy();
  expect(match!.getAttribute('role')).toBe('button');
  expect(accessibleName(match!).length).toBeGreaterThan(0);
}

it('names the reaction chip as a button', () => {
  const host = mount(
    <MessageReactionRoster
      desktop
      messageId="m1"
      onReact={() => undefined}
      reaction={{ emoji: '👍', count: 1, reacted: false }}
    />,
  );
  expectButton(host, '👍, 1 reaction');
});

it('names the Report confirmation as a button', () => {
  const host = mount(
    <WebPromptModal
      config={{
        id: 'report',
        type: 'prompt',
        ...REPORT_ISSUE_PROMPT,
      }}
      onConfirm={() => undefined}
    />,
  );
  expectButton(host, 'Report');
});

it('names the Delete confirmation as a button', () => {
  const host = mount(
    <WebAlertModal
      config={{
        id: 'delete',
        type: 'confirm',
        title: 'Delete message?',
        message: 'The message text and attachments will be removed.',
        cancelText: 'Cancel',
        confirmText: 'Delete',
        destructive: true,
      }}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  expectButton(host, 'Delete');
});

it('names the Leave confirmation as a button', () => {
  const host = mount(
    <WebAlertModal
      config={{
        id: 'leave',
        type: 'confirm',
        title: 'Leave #general?',
        message: 'Other members keep their access.',
        cancelText: 'Cancel',
        confirmText: 'Leave',
        destructive: true,
      }}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  expectButton(host, 'Leave');
});

it('names Stop as a button', () => {
  const host = mount(<TurnProgressLine label="Jimmy thinking…" onStop={() => undefined} testID="turn" />);
  expectButton(host, 'Stop this turn');
});
