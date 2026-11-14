import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
import { Platform } from 'react-native';
import { createTranscriptScrubberStore } from '@/buzz/use-transcript-scrubber';
import { headerRevealAfterScroll, useTitleBlockVisibility } from './useTitleBlockVisibility';

it('follows direction anywhere, including a scroll up close to the newest message', () => {
  expect(headerRevealAfterScroll(false, 450, 456)).toBe(true);
  expect(headerRevealAfterScroll(true, 456, 400)).toBe(false);
  expect(headerRevealAfterScroll(false, 400, 406)).toBe(true);
  expect(headerRevealAfterScroll(false, 0, 6)).toBe(true);
  expect(headerRevealAfterScroll(true, 6, 0)).toBe(false);
});

it('keeps visibility on the first observation, stationary frames and rounding noise', () => {
  for (const shown of [false, true]) {
    expect(headerRevealAfterScroll(shown, null, 450)).toBe(shown);
    expect(headerRevealAfterScroll(shown, 450, 450)).toBe(shown);
    expect(headerRevealAfterScroll(shown, 450, 450.5)).toBe(shown);
    expect(headerRevealAfterScroll(shown, 450, 449.5)).toBe(shown);
  }
});

afterEach(() => { vi.unstubAllGlobals(); Platform.OS = 'android'; });

function mount(positions?: Parameters<typeof useTitleBlockVisibility>[1]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let current!: ReturnType<typeof useTitleBlockVisibility>;
  let renders = 0;
  let top = -200;
  function Header() {
    current = useTitleBlockVisibility(true, positions);
    renders++;
    return null;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(React.createElement(Header)); });
  // The real title block stays at the oldest end of the transcript.
  current.blockRef.current = { measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, top, 390, 120) } as never;
  current.barRef.current = { measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, 0, 390, 50) } as never;
  act(() => current.onBarLayout());
  return {
    get current() { return current; },
    get renders() { return renders; },
    showTop() { top = 50; act(() => current.onBlockLayout()); },
    unmount() { act(() => tree.unmount()); },
  };
}

it.each(['android', 'web'] as const)('%s inverted list: reverses in mid-transcript, ignores anchoring, and never renders for unchanged scroll frames', (platform) => {
  Platform.OS = platform;
  const positions = createTranscriptScrubberStore();
  const header = mount(positions);
  const scroll = (offset: number, reader = true) => act(() => positions.observeScroll({
    contentOffset: { y: offset }, contentSize: { height: 4000 }, layoutMeasurement: { height: 600 },
  }, reader));
  scroll(400);
  expect(header.current.expanded).toBe(false);
  scroll(410);
  expect(header.current.expanded).toBe(true);
  const shownRenders = header.renders;
  for (let offset = 420; offset <= 600; offset += 10) scroll(offset);
  expect(header.renders).toBe(shownRenders);
  scroll(590);
  expect(header.current.expanded).toBe(false);
  const hiddenRenders = header.renders;
  for (let offset = 580; offset >= 400; offset -= 10) scroll(offset);
  expect(header.renders).toBe(hiddenRenders);
  scroll(800, false); // A layout/anchoring move is not a reader gesture.
  expect(header.current.expanded).toBe(false);
  scroll(790);
  expect(header.current.expanded).toBe(false);
  scroll(796);
  expect(header.current.expanded).toBe(true);
  scroll(200, false);
  expect(header.current.expanded).toBe(true);
  header.showTop();
  expect(header.current.collapsed).toBe(false);
  expect(header.current.expanded).toBe(false); // The original title block is visible instead.
  const topRenders = header.renders;
  scroll(210);
  scroll(220);
  expect(header.renders).toBe(topRenders);
  header.unmount();
  positions.dispose();
});

it('web: captured transcript scrolls reverse immediately, taps expand, and listeners clean up', () => {
  Platform.OS = 'web';
  const listeners = new Set<(event: Event) => void>();
  vi.stubGlobal('window', {
    addEventListener: (_type: string, listener: (event: Event) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: Event) => void) => listeners.delete(listener),
  });
  const header = mount();
  const node = { scrollHeight: 4000, clientHeight: 600, scrollTop: 2500,
    getAttribute: () => 'chat-messages' };
  const scroll = (top: number) => act(() => {
    node.scrollTop = top;
    listeners.forEach(listener => listener({ target: node } as unknown as Event));
  });
  scroll(2500);
  scroll(2490);
  expect(header.current.expanded).toBe(true);
  const shownRenders = header.renders;
  for (let top = 2480; top >= 2300; top -= 10) scroll(top);
  expect(header.renders).toBe(shownRenders);
  // Expanding the header shrinks the viewport; arriving history grows content.
  // Neither is reader movement, even on the first downward scroll afterward.
  node.clientHeight = 400;
  node.scrollHeight = 4400;
  scroll(2310);
  expect(header.current.expanded).toBe(false);
  act(() => header.current.expand());
  expect(header.current.expanded).toBe(true);
  scroll(2320);
  expect(header.current.expanded).toBe(false);
  header.showTop();
  expect(header.current.collapsed).toBe(false);
  header.unmount();
  expect(listeners.size).toBe(0);
});
