import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const builder: Record<string, (value: unknown) => unknown> = {};
  for (const name of ['duration', 'delay', 'easing', 'withInitialValues', 'reduceMotion'])
    builder[name] = (value: unknown) => { calls.push([name, value]); return builder; };
  return {
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children) },
    Easing: { bezier: (...points: number[]) => `bezier(${points.join(',')})` },
    FadeInDown: builder,
    ReduceMotion: { System: 'system' },
  };
});

import { Rise } from './Rise';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the onboarding rise-in', () => {
  it('rises 10 points over 380 ms, 80 ms per block, and stays still under reduced motion', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Rise, { order: 2, children: 'block' })); });
    expect(Object.fromEntries(calls)).toEqual({
      duration: 380,
      delay: 160,
      easing: 'bezier(0.2,0.7,0.2,1)',
      withInitialValues: { opacity: 0, transform: [{ translateY: 10 }] },
      reduceMotion: 'system',
    });
    expect(renderer.root.findByType('AnimatedView' as any).props.children).toBe('block');
  });
});
