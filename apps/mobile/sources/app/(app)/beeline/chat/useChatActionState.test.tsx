import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { prefetchRoomOpen } from '@/push/push-room-prefetch';
vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'web' } }));
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), selectionAsync: vi.fn(), NotificationFeedbackType: {} }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/buzz/use-text-draft', () => ({ useTextDraft: () => ['', vi.fn(), {}] }));
vi.mock('@/buzz/room-list-new-corner', () => ({ alertCornerOpenFailure: vi.fn() }));
vi.mock('@/buzz/message-corner-forward', () => ({ takeCornerComposerDraft: () => undefined, forwardMessageToNewCorner: vi.fn() }));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchRoomOpen: vi.fn() }));
import { useChatActionState } from './useChatActionState';
import { useChatCornerActions } from './useChatCornerActions';

it('guards corner creation without redrawing the departing conversation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let accept!: (id: string) => void;
  const created = new Promise<string>(resolve => { accept = resolve; });
  const createHumanCorner = vi.fn(() => created);
  let open!: () => Promise<void>;
  let renders = 0;
  function Fixture() {
    renders++;
    const state = useChatActionState(['room', 'viewer', null, { current: '' }, '', vi.fn(), vi.fn(), vi.fn(), vi.fn(), { current: null }]);
    const props = [false, {}, 'Room', vi.fn(), vi.fn(), false, vi.fn(), state[46], false, false,
      { createHumanCorner }, state[47], undefined, 'room', false, vi.fn(), vi.fn(), null, 'Room'];
    [, , open] = useChatCornerActions(props as unknown as Parameters<typeof useChatCornerActions>[0]);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  let pending!: Promise<void>;
  try {
    act(() => { renderer = create(<Fixture />); });
    const mounted = renders;
    act(() => { pending = open(); void open(); });
    expect(createHumanCorner).toHaveBeenCalledOnce();
    expect(renders).toBe(mounted);
    await act(async () => { accept('accepted-corner'); await pending; });
    expect(renders).toBe(mounted);
  } finally { act(() => renderer.unmount()); }
});

it('warms the parent only when its corner actions are opened', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(prefetchRoomOpen).mockClear();
  let show!: React.Dispatch<React.SetStateAction<boolean>>;
  function Fixture() {
    const surface = { room: { parentId: 'parent' } } as unknown as Parameters<typeof useChatActionState>[0][2];
    const state = useChatActionState(['corner', 'viewer', surface, { current: '' }, '', vi.fn(), vi.fn(), vi.fn(), vi.fn(), { current: null }]);
    show = state[58];
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  try {
    act(() => { renderer = create(<Fixture />); });
    expect(prefetchRoomOpen).not.toHaveBeenCalled();
    act(() => show(true));
    expect(prefetchRoomOpen).toHaveBeenCalledExactlyOnceWith('parent');
    act(() => show(false));
    expect(prefetchRoomOpen).toHaveBeenCalledOnce();
  } finally { act(() => renderer.unmount()); }
});
