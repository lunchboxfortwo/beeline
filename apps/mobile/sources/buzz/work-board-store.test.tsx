import React from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkBoard } from './work-board-store';
const mock = vi.hoisted(() => ({
  generation: 0,
  resets: new Set<() => void>(),
  listeners: new Set<(event: unknown) => void>(),
  connected: new Set<() => void>(),
  read: vi.fn(),
}));
vi.mock('@/sync/client-reset', () => ({
  clientResetGeneration: () => mock.generation,
  subscribeClientReset: (fn: () => void) => {
    mock.resets.add(fn);
    return () => mock.resets.delete(fn);
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mock.read }));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, fn: (event: unknown) => void) => {
      mock.listeners.add(fn);
      return () => mock.listeners.delete(fn);
    },
    subscribeConnected: (fn: () => void) => {
      mock.connected.add(fn);
      return () => mock.connected.delete(fn);
    },
  }),
}));
const board = (name: string) => ({
  workspaceId: 'ws',
  workspaceName: name,
  viewerId: name,
  items: [],
  chats: [],
  people: [],
});
let tree: any;
function Probe() {
  const value = useWorkBoard('ws');
  return <pre>{value?.workspaceName ?? 'empty'}</pre>;
}
async function mount() {
  await act(async () => {
    tree = create(<Probe />);
  });
}
const name = () => tree.root.findByType('pre').props.children;
function reset() {
  mock.generation++;
  for (const fn of mock.resets) fn();
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  reset();
  mock.read.mockReset();
  mock.read.mockResolvedValue(board('current'));
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
});
describe('Work board whole server response ownership', () => {
  it('reads once on open and once on a connection event without a polling clock', async () => {
    await mount();
    expect(mock.read).toHaveBeenCalledTimes(1);
    expect(name()).toBe('current');
    await act(async () => {
      for (const fn of mock.connected) fn();
    });
    expect(mock.read).toHaveBeenCalledTimes(2);
  });
  it('covers an invalidation received while the opening read is in flight', async () => {
    let finish!: (v: unknown) => void;
    mock.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(board('newest'));
    await mount();
    await act(async () => {
      for (const fn of mock.listeners)
        fn({ monolithLive: { type: 'invalidate', roomId: '', reason: 'work-board-gap' } });
    });
    expect(mock.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(board('old snapshot'));
    });
    expect(mock.read).toHaveBeenCalledTimes(2);
    expect(name()).toBe('newest');
  });
  it('never installs a response from the previous account after a client reset', async () => {
    let finish!: (v: unknown) => void;
    mock.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(board('new account'));
    await mount();
    await act(async () => reset());
    expect(name()).toBe('new account');
    await act(async () => finish(board('previous account')));
    expect(name()).toBe('new account');
  });
});
