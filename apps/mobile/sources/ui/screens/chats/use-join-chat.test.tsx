import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('./chat-tree-model', () => ({ joinableTitle: (name: string) => `#${name}` }));
import { useJoinChat } from './use-join-chat';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { operation.mockReset(); });
function mount(viewer: string | null = 'person') {
  const refresh = vi.fn(), open = vi.fn(), fail = vi.fn();
  let current!: ReturnType<typeof useJoinChat>;
  function Fixture() { current = useJoinChat(viewer, refresh, open, fail); return null; }
  let tree: any;
  act(() => { tree = create(<Fixture />); });
  return { get current() { return current; }, refresh, open, fail, unmount: () => act(() => tree.unmount()) };
}

it('clears on the existing phone operation, waits for commit, then refreshes without opening a chat', async () => {
  let finish!: () => void;
  operation.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const fixture = mount();
  let clearing!: Promise<void>;
  act(() => { clearing = fixture.current.clearJoinable('workspace'); });
  expect(fixture.current.clearing).toBe(true);
  expect(operation).toHaveBeenCalledWith('clearJoinableChats', { workspaceId: 'workspace' });
  expect(fixture.refresh).not.toHaveBeenCalled();
  await act(async () => { finish(); await clearing; });
  expect(fixture.refresh).toHaveBeenCalledOnce();
  expect(fixture.open).not.toHaveBeenCalled();
  expect(fixture.fail).not.toHaveBeenCalled();
  expect(fixture.current.clearing).toBe(false);
  fixture.unmount();
});

it('keeps the committed list on a refused Clear and releases the pending control', async () => {
  operation.mockRejectedValue(new Error('workspace membership required'));
  const fixture = mount();
  await act(async () => { await fixture.current.clearJoinable('workspace'); });
  expect(fixture.refresh).not.toHaveBeenCalled();
  expect(fixture.fail).toHaveBeenCalledOnce();
  expect(fixture.current.clearing).toBe(false);
  fixture.unmount();
});

it('does not issue a Clear before the viewer is restored', async () => {
  const fixture = mount(null);
  await act(async () => { await fixture.current.clearJoinable('workspace'); });
  expect(operation).not.toHaveBeenCalled();
  expect(fixture.refresh).not.toHaveBeenCalled();
  fixture.unmount();
});
