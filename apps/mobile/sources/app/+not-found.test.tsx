import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const replace = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ router: { replace } }));
vi.mock('tamagui', () => ({ YStack: 'YStack' }));
vi.mock('@/ui/grammar', () => ({ Btn: 'Btn', T: 'T' }));
vi.mock('@/components/buzz/BeelineMark', () => ({ BeelineMark: 'BeelineMark' }));
import NotFound from './+not-found';

it('W2 gives an unknown route a branded way back to chats', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let tree: any;
  act(() => { tree = create(<NotFound />); });
  expect(tree.root.findByType('BeelineMark')).toBeDefined();
  expect(tree.root.findByType('T').props.children).toBe('Page not found');
  act(() => tree.root.findByType('Btn').props.onPress());
  expect(replace).toHaveBeenCalledWith('/beeline/channels');
  act(() => tree.unmount());
});
