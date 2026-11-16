import React from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const focus = vi.hoisted(() => ({ active: true }));
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => (() => void)) => React.useEffect(() => {
    if (focus.active) return effect();
  }, [effect, focus.active]),
}));
vi.mock('@/navigation/initial-landing', () => ({
  afterFirstFrame: (run: () => void) => {
    const timer = setTimeout(run, 32);
    return () => clearTimeout(timer);
  },
}));
import { useRelativeTimeRefresh } from './use-relative-time-refresh';

it('refreshes after the return frame and once per minute only while focused, cancelling on blur', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  focus.active = true;
  const setNow = vi.fn();
  const refresh = vi.fn();
  const blur = vi.fn();
  const onFocus = vi.fn(() => blur);
  function Clock() { useRelativeTimeRefresh(setNow, refresh, onFocus); return null; }
  let tree: any;
  act(() => { tree = create(<Clock />); });
  try {
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(setNow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(32));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(setNow).toHaveBeenLastCalledWith(Date.now());
    act(() => vi.advanceTimersByTime(60_000 - 32));
    expect(setNow).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    focus.active = false;
    act(() => tree.update(<Clock />));
    expect(blur).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(120_000));
    expect(setNow).toHaveBeenCalledTimes(2);
    focus.active = true;
    act(() => tree.update(<Clock />));
    expect(onFocus).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
    act(() => vi.advanceTimersByTime(60_000));
    expect(setNow).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { act(() => tree.unmount()); vi.useRealTimers(); }
});
