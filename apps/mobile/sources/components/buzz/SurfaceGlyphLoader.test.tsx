import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';

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

import { StepDot } from '@/ui/screens/settings/connectors/ConnectSteps';
import { StateDot } from './StateDot';
import { SettledLine } from '@/ui/screens/transcript/cards/RequestCard';
import { WorkflowStepCircle } from './WorkflowStepCircle';
import { Spinner } from '@/ui/grammar';
import { WorkflowWorkingMark } from './WorkflowWorkingMark';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { PageLoader } from '@/ui/PageLoader';

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
    expect(page.root.findAllByType('Circle')).toHaveLength(1);
    expect(page.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
  });
});

describe('Room/thread opening safe area', () => {
  it.each([0, 24, 48])('reserves the composer foot above a bottom inset of %s', async (bottom) => {
    const { ChatOpeningSurface } = await import('./ChatOpeningSurface');
    const { composerBottomPadding } = await import('@/buzz/composer-keyboard');
    safeArea.bottom = bottom;
    const tree = render(<ChatOpeningSurface isCorner />);
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
    expect(tree.root.findAllByType('Circle')).toHaveLength(1);
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


describe('workflow execution marks', () => {
  it('spins only for executing work, with static marks for waits and viewer holds', () => {
    const executing = render(<WorkflowWorkingMark kind="handoff" holder={{ id: 'agent', kind: 'agent', name: 'Bee' }} viewerHolds={false} />);
    expect(executing.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
    act(() => executing.unmount());
    for (const viewerHolds of [true, false]) {
      const waiting = render(<WorkflowWorkingMark kind="gate" viewerHolds={viewerHolds} />);
      expect(waiting.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(0);
      expect(waiting.root.findByType('Svg').props.accessibilityLabel).toBe(viewerHolds ? 'needs you' : 'working');
      act(() => waiting.unmount());
    }
  });
});

describe('shared workflow rail marks', () => {
  it('uses a filled disc inside a ring for completed steps', () => {
    const tree = render(<WorkflowStepCircle status="done" />);
    const svg = tree.root.findByType('Svg');
    expect(svg.props.accessibilityLabel).toBe('done');
    const circles = tree.root.findAllByType('Circle');
    expect(circles).toHaveLength(2);
    expect(circles[0].props.fill).toBe('none');
    expect(circles[1].props.fill).toBe(circles[0].props.stroke);
    expect(circles[1].props.r).toBeLessThan(circles[0].props.r);
    expect(tree.root.findAllByType('Path')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it.each(['current', 'pending'] as const)('draws %s as working or idle, without a done disc', (status) => {
    const tree = render(<WorkflowStepCircle status={status} />);
    expect(tree.root.findByType('Svg').props.accessibilityLabel).toBe(status === 'current' ? 'working' : 'idle');
    expect(tree.root.findAllByType('Circle')).toHaveLength(1);
    expect(tree.root.findAllByType('Path')).toHaveLength(status === 'current' ? 1 : 0);
    act(() => tree.unmount());
  });
});

describe('spinner colour', () => {
  it('uses the state ink by default and allows control text ink inside a control', () => {
    const standalone = render(<Spinner />);
    const ink = standalone.root.findByType('Circle').props.stroke;
    expect(ink).toBe('needsYou');
    act(() => standalone.unmount());
    const control = render(<button><Spinner color="primaryInk" /></button>);
    const controlInk = control.root.findByType('Circle').props.stroke;
    expect(controlInk).toBe('primaryInk');
    expect(controlInk).not.toBe(ink);
    act(() => control.unmount());
  });
});

describe('connector and completion marks', () => {
  it.each([
    ['done', 'done'], ['waiting', 'needs you'], ['todo', 'idle'], ['failed', 'failed'],
  ] as const)('renders a %s connector step in the shared state ink', (state, label) => {
    const tree = render(<StepDot state={state} />);
    expect(tree.root.findByType('Svg').props.accessibilityLabel).toBe(label);
    for (const circle of tree.root.findAllByType('Circle')) expect(circle.props.stroke ?? circle.props.fill).toBe('needsYou');
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('spins the running connector step', () => {
    const tree = render(<StepDot state="current" />);
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
    act(() => tree.unmount());
  });

  it.each(['live', 'failed'] as const)('uses the shared glyph for the %s task indicator', kind => {
    const tree = render(<StateDot kind={kind} />);
    expect(tree.root.findByType('Svg').props.accessibilityLabel).toBe(kind === 'live' ? 'done' : 'failed');
    for (const circle of tree.root.findAllByType('Circle')) expect(circle.props.stroke ?? circle.props.fill).toBe('needsYou');
    act(() => tree.unmount());
  });

  it('marks a decided request with a disc inside a ring', () => {
    const tree = render(<SettledLine>Approved by Ada</SettledLine>);
    expect(tree.root.findByType('Svg').props.accessibilityLabel).toBe('done');
    const circles = tree.root.findAllByType('Circle');
    expect(circles).toHaveLength(2);
    expect(circles[0].props.fill).toBe('none');
    expect(circles[1].props.fill).toBe(circles[0].props.stroke);
    expect(tree.root.findAllByType('Path')).toHaveLength(0);
    act(() => tree.unmount());
  });
});
