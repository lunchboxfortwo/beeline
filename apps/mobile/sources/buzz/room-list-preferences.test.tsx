import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.values.set(key, value); },
} }));
import { useChatFilters } from './room-list-preferences';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => storage.values.clear());

it('keeps filters scoped to the viewer and Workspace', async () => {
  let current: ReturnType<typeof useChatFilters>;
  const Probe = ({ viewer = 'me', workspace = 'work' }) => { current = useChatFilters(viewer, workspace); return null; };
  let tree: any;
  await act(async () => { tree = create(<Probe />); });
  try {
    await act(async () => { current![1](['unread', 'pinned']); });
    await act(async () => { tree.update(<Probe viewer="other" />); });
    expect(current![0]).toEqual([]);
    await act(async () => { tree.update(<Probe workspace="other" />); });
    expect(current![0]).toEqual([]);
    await act(async () => { tree.update(<Probe />); });
    expect(current![0]).toEqual(['unread', 'pinned']);
  } finally { act(() => tree.unmount()); }
});

it('waits for a preference write still in flight when the screen remounts', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const write = vi.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
    await pending;
    storage.values.set(key, value);
  });
  let current: ReturnType<typeof useChatFilters>;
  const Probe = () => { current = useChatFilters('me', 'work'); return null; };
  let tree: any;
  try {
    await act(async () => { tree = create(<Probe />); });
    await act(async () => { current![1](['pinned']); });
    act(() => tree.unmount());
    await act(async () => { tree = create(<Probe />); });
    await act(async () => { release(); });
    expect(current![0]).toEqual(['pinned']);
  } finally { release(); act(() => tree?.unmount()); write.mockRestore(); }
});
