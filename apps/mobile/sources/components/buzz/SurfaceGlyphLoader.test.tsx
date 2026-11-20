import * as React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';

type LoadingTreatment = 'spinner' | 'exception';
type LoadingSurface = {
  id: string;
  file: string;
  treatment: LoadingTreatment;
  reason?: string;
};

/**
 * Every normal-use loading surface and its treatment: the one ring spinner
 * (directly or through PageLoader/SurfaceGlyphLoader). A surface that shows
 * something else must land here as an explicit exception — never silently.
 * Paths are relative to `apps/mobile/sources`.
 */
const LOADING_SURFACES: readonly LoadingSurface[] = [
  { id: 'voice-startup', file: 'components/buzz/VoiceBar.tsx', treatment: 'spinner' },
  { id: 'thinking', file: 'components/buzz/TurnProgressLine.tsx', treatment: 'spinner' },
  { id: 'activity-working', file: 'components/buzz/ActivityTimeline.tsx', treatment: 'spinner' },
  { id: 'room-corner-entry', file: 'components/buzz/ChatOpeningSurface.tsx', treatment: 'spinner' },
  { id: 'room-deck', file: 'app/(app)/beeline/channels.tsx', treatment: 'spinner' },
  { id: 'people', file: 'ui/screens/people/PeopleTabScreen.tsx', treatment: 'spinner' },
  { id: 'workspace-settings', file: 'ui/screens/settings/WorkspaceSettings.tsx', treatment: 'spinner' },
  { id: 'agent-profile', file: 'ui/screens/profiles/AgentProfileScreen.tsx', treatment: 'spinner' },
  { id: 'person-profile', file: 'ui/screens/profiles/PersonProfileScreen.tsx', treatment: 'spinner' },
  { id: 'community', file: 'ui/screens/onboarding/WorkspaceSetup.tsx', treatment: 'spinner' },
  { id: 'schedules', file: 'app/(app)/beeline/settings/schedules.tsx', treatment: 'spinner' },
  { id: 'workbench', file: 'app/(app)/beeline/settings/workbench.tsx', treatment: 'spinner' },
  {
    id: 'workbench-connect',
    file: 'app/(app)/beeline/settings/workbench/connect.tsx',
    treatment: 'spinner',
  },
  { id: 'wallet', file: 'app/(app)/beeline/settings/workbench/wallet.tsx', treatment: 'spinner' },
  { id: 'tray', file: 'app/(app)/beeline/tray.tsx', treatment: 'spinner' },
  {
    id: 'forward-picker',
    file: 'components/buzz/ForwardMessagePickerSheet.tsx',
    treatment: 'spinner',
  },
  { id: 'desktop-sidebar', file: 'components/SidebarView.tsx', treatment: 'spinner' },
  { id: 'invite-join', file: 'app/(app)/join/[token].tsx', treatment: 'spinner' },
  { id: 'review-signin', file: 'app/(app)/review/[secret].tsx', treatment: 'spinner' },
  { id: 'button-busy', file: 'components/buzz/Button.tsx', treatment: 'spinner' },
  { id: 'choice-plate-busy', file: 'components/buzz/ChoicePlate.tsx', treatment: 'spinner' },
  { id: 'ota-check-busy', file: 'ui/screens/settings/YouSettings.tsx', treatment: 'spinner' },
  {
    id: 'history-line',
    file: 'app/(app)/beeline/chat/_chat-surface.tsx',
    treatment: 'exception',
    reason:
      '"Loading earlier messages…" is an inscribed transcript history row, not a load gate. A spinner would interrupt the ledger.',
  },
  {
    id: 'artifact-preview',
    file: 'components/buzz/ArtifactCard.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped preview placeholder; cache hits resolve in well under 100ms and a spinner would flash.',
  },
  {
    id: 'artifact-viewer',
    file: 'components/buzz/ArtifactViewer.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped viewer placeholder while preview bytes or the native module resolve; same flash risk as the card.',
  },
  {
    id: 'desktop-artifact',
    file: 'components/buzz/DesktopArtifactPane.tsx',
    treatment: 'exception',
    reason: 'Shares the artifact viewer placeholder; not a Room/Corner load gate.',
  },
  { id: 'webview-signin', file: 'app/(app)/beeline/settings/workbench/connect-signin.tsx', treatment: 'spinner' },
];

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Text: host('Text'),
    View: host('View'),
  };
});

const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: safeArea.bottom, left: 0, right: 0 }) }));
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Circle: host('Circle'), Path: host('Path'), G: host('G') };
});

const motion = vi.hoisted(() => ({
  reducedMotion: false,
  repeats: [] as Array<{ count: unknown; reverse: unknown }>,
}));

const themeRef = vi.hoisted(() => ({
  current: { buzz: { dark: true } },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props),
      createAnimatedComponent: () => (props: any) =>
        ReactModule.createElement('AnimatedPath', props),
    },
    Easing: {
      cubic: 'cubic',
      inOut: (fn: unknown) => fn,
      linear: 'linear',
      out: (fn: unknown) => fn,
    },
    ReduceMotion: { System: 'system' },
    cancelAnimation: vi.fn(),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedProps: (factory: () => unknown) => factory(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_ms: number, value: unknown) => value,
    withRepeat: (value: unknown, count: unknown, reverse: unknown) => {
      motion.repeats.push({ count, reverse });
      return value;
    },
    withSequence: (...steps: unknown[]) => steps,
    withTiming: (value: number) => value,
  };
});

import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { PageLoader } from '@/ui/PageLoader';

const originalConsoleError = console.error;
const SOURCES_ROOT = path.resolve(__dirname, '../..');

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

beforeEach(() => {
  themeRef.current = { buzz: beelineThemes.obsidian };
});

afterEach(() => {
  safeArea.bottom = 0;
  motion.reducedMotion = false;
  motion.repeats = [];
  themeRef.current = { buzz: beelineThemes.obsidian };
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function dots(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('View').filter((node: any) => {
    const style = node.props.style;
    const resolved = Array.isArray(style) ? Object.assign({}, ...style) : style;
    return resolved?.width === 5 || resolved?.width === 7;
  });
}

const SPINNER_MARKERS = ['PageLoader', 'SurfaceGlyphLoader', '<Spinner'] as const;
/** The Beeline mark is the brand: drawn still on the update gate, never as a loader. */
const BRAND_MARK_FILES = new Set(['components/StoreUpdateGate.tsx', 'components/buzz/BeelineGlyphPaint.tsx']);

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) return walkSourceFiles(full);
    if (!/\.(ts|tsx)$/.test(name)) return [];
    if (/\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

const relative = (file: string) => path.relative(SOURCES_ROOT, file).replaceAll('\\', '/');

describe('SurfaceGlyphLoader', () => {
  it('turns the one ring spinner at the page size, never dots or the Beeline mark', () => {
    const renderer = render(React.createElement(SurfaceGlyphLoader));
    const spinner = renderer.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'surface-glyph-loader-glyph');
    expect(spinner.props.accessibilityRole).toBe('progressbar');
    expect(renderer.root.findByType('Svg').props.width).toBe(32);
    expect(renderer.root.findAllByType('Circle')).toHaveLength(1);
    expect(renderer.root.findAllByType('AnimatedPath')).toHaveLength(0);
    expect(motion.repeats[0]?.reverse).toBe(false);
    expect(dots(renderer)).toHaveLength(0);
  });

  it('keeps compact loaders at the inline spinner size', () => {
    const renderer = render(React.createElement(SurfaceGlyphLoader, { compact: true }));
    expect(renderer.root.findByType('Svg').props.width).toBe(16);
    expect(dots(renderer)).toHaveLength(0);
  });

  it('holds still under reduced motion', () => {
    motion.reducedMotion = true;
    render(React.createElement(SurfaceGlyphLoader));
    expect(motion.repeats).toHaveLength(0);
  });
});

describe('Page loading boundary', () => {
  it('fills the page on canvas and centres the one spinner', () => {
    const page = render(React.createElement(PageLoader, { testID: 'rooms-loader-gate' }));
    const gate = page.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'rooms-loader-gate');
    expect(gate.props).toMatchObject({ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'canvas' });
    expect(page.root.findAllByType('Svg')).toHaveLength(1);
  });
});

describe('Room/thread opening safe area', () => {
  it.each([0, 24, 48])('reserves the composer foot above a bottom inset of %s', async (bottom) => {
    const { ChatOpeningSurface } = await import('./ChatOpeningSurface');
    const { composerBottomPadding } = await import('@/buzz/composer-keyboard');
    safeArea.bottom = bottom;
    const tree = render(<ChatOpeningSurface isCorner />);
    const foot = tree.root.findAllByType('AnimatedView').find((node: any) => node.props.testID === 'room-loading-safe-bottom');
    const style = Array.isArray(foot.props.style) ? Object.assign({}, ...foot.props.style) : foot.props.style;
    expect(style.height).toBe(composerBottomPadding('android', bottom, 0));
    const footer = tree.root.findByProps({ testID: 'room-loading-footer' });
    expect(footer.props.minHeight).toBe(44);
    const caption = tree.root.findAllByType('Text').find((node: any) => node.props.testID === 'room-loading-caption');
    expect(caption.props.fontFamily).toBe('SpaceGrotesk-Regular');
    act(() => tree.unmount());
  });
});

describe('normal-use loading surfaces', () => {
  it('records a reason for every surface that stays off the glyph', () => {
    for (const surface of LOADING_SURFACES) {
      if (surface.treatment === 'exception') {
        expect(surface.reason?.trim().length, surface.id).toBeGreaterThan(10);
      } else {
        expect(surface.reason, surface.id).toBeUndefined();
      }
    }
  });

  it('keeps every loading surface on the one ring spinner', () => {
    for (const surface of LOADING_SURFACES.filter((entry) => entry.treatment === 'spinner')) {
      const source = readFileSync(path.join(SOURCES_ROOT, surface.file), 'utf8');
      expect(
        SPINNER_MARKERS.some((marker) => source.includes(marker)),
        `${surface.file} is a loading surface but mounts none of ${SPINNER_MARKERS.join(', ')}`,
      ).toBe(true);
    }
  });

  it('has one spinner: no platform spinner and no Beeline mark as a loader', () => {
    for (const file of walkSourceFiles(SOURCES_ROOT)) {
      const source = readFileSync(file, 'utf8');
      const name = relative(file);
      expect(source, `${name} imports another spinner`).not.toMatch(/import \{[^}]*\bSpinner\b[^}]*\} from 'tamagui'/);
      expect(source, `${name} mounts ActivityIndicator`).not.toMatch(/<ActivityIndicator\b/);
      if (!BRAND_MARK_FILES.has(name)) expect(source, `${name} draws the Beeline mark`).not.toMatch(/<BeelineGlyphPaint\b/);
    }
  });
});
