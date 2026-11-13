import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';

const confirm = vi.fn();
vi.mock('@/modal', () => ({ Modal: { confirm, alert: vi.fn() } }));
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), NotificationFeedbackType: { Success: 'success' } }));
vi.mock('react-native-gesture-handler', () => ({ Swipeable: class {} }));
vi.mock('@/buzz/use-room-list-gestures', () => ({ useRoomListGestures: () => ({}) }));
vi.mock('@/buzz/app-error-copy', () => ({ appErrorCopy: (_: unknown, fallback: string) => fallback }));
vi.mock('@/buzz/room-list-row', () => ({ roomRowName: (item: ChatListItem) => ({ sigil: '#', name: item.room.name }) }));
vi.mock('@/buzz/vocabulary', () => ({ ROOM_LABEL: 'Room' }));

const { useChannelsRoomActions } = await import('./useChannelsRoomActions');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: string, directMessage = false) =>
  ({ room: { id, name: id }, ...(directMessage ? { directMessage: true } : {}) }) as unknown as ChatListItem;
const rows = [chat('a'), chat('b'), chat('dm', true)];

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount(transport: { leaveRoom: ReturnType<typeof vi.fn>; closeChat: ReturnType<typeof vi.fn> }) {
  const setError = vi.fn();
  const force = vi.fn();
  let actions!: ReturnType<typeof useChannelsRoomActions>;
  function Probe({ list, shown = list }: { list: ChatListItem[]; shown?: ChatListItem[] }) {
    actions = useChannelsRoomActions({ transport, chatStore: { current: { force } }, setError } as never, shown, list);
    return null;
  }
  let tree!: { update: (node: React.ReactElement) => void };
  act(() => { tree = create(<Probe list={rows} />); });
  return {
    visible: () => actions.visibleRows.map((row) => row.room.id),
    actions: () => actions,
    rerender: (list: ChatListItem[], shown?: ChatListItem[]) => act(() => tree.update(<Probe list={list} shown={shown} />)),
    setError,
    force,
  };
}

beforeEach(() => {
  confirm.mockReset();
  confirm.mockResolvedValue(true);
});

it('hides a Room row as soon as the person confirms Leave, before the server answers', async () => {
  const call = deferred();
  const view = mount({ leaveRoom: vi.fn(() => call.promise), closeChat: vi.fn() });
  let leaving!: Promise<void>;
  await act(async () => { leaving = view.actions().handleLeaveRoom(rows[1]!); });
  expect(view.visible()).toEqual(['a', 'dm']);
  await act(async () => { call.resolve(); await leaving; });
  expect(view.force).toHaveBeenCalledTimes(1);
  expect(view.visible()).toEqual(['a', 'dm']);
  // The refreshed list no longer has the Room; a later rejoin shows it again.
  view.rerender([rows[0]!, rows[2]!]);
  view.rerender(rows);
  expect(view.visible()).toEqual(['a', 'b', 'dm']);
});

it('brings the Room row back with the existing error when the leave fails', async () => {
  const call = deferred();
  const view = mount({ leaveRoom: vi.fn(() => call.promise), closeChat: vi.fn() });
  let leaving!: Promise<void>;
  await act(async () => { leaving = view.actions().handleLeaveRoom(rows[1]!); });
  expect(view.visible()).toEqual(['a', 'dm']);
  await act(async () => { call.reject(new Error('offline')); await leaving; });
  expect(view.visible()).toEqual(['a', 'b', 'dm']);
  expect(view.setError).toHaveBeenCalledWith('Could not leave Room.');
});

it('keeps the row when the person cancels, and restores it when they decline the last-admin delete', async () => {
  const leaveRoom = vi.fn().mockRejectedValueOnce(new Error('last_admin_confirmation_required'));
  const view = mount({ leaveRoom, closeChat: vi.fn() });
  confirm.mockResolvedValueOnce(false);
  await act(async () => { await view.actions().handleLeaveRoom(rows[0]!); });
  expect(leaveRoom).not.toHaveBeenCalled();
  expect(view.visible()).toEqual(['a', 'b', 'dm']);
  confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await act(async () => { await view.actions().handleLeaveRoom(rows[0]!); });
  expect(leaveRoom).toHaveBeenCalledTimes(1);
  expect(view.visible()).toEqual(['a', 'b', 'dm']);
});

it('hides a direct message at once on Close and restores it when Close fails', async () => {
  const call = deferred();
  const view = mount({ leaveRoom: vi.fn(), closeChat: vi.fn(() => call.promise) });
  let closing!: Promise<void>;
  await act(async () => { closing = view.actions().handleCloseChat(rows[2]!); });
  expect(view.visible()).toEqual(['a', 'b']);
  await act(async () => { call.reject(new Error('offline')); await closing; });
  expect(view.visible()).toEqual(['a', 'b', 'dm']);
  expect(view.setError).toHaveBeenCalledWith('Could not close chat.');
});

it.each([
  ['Leave', 1, (actions: ReturnType<typeof useChannelsRoomActions>, item: ChatListItem) => actions.handleLeaveRoom(item)],
  ['Close', 2, (actions: ReturnType<typeof useChannelsRoomActions>, item: ChatListItem) => actions.handleCloseChat(item)],
] as const)('keeps a row gone after a successful %s while search changes before the refresh lands', async (_, index, run) => {
  const view = mount({ leaveRoom: vi.fn(async () => true), closeChat: vi.fn(async () => undefined) });
  const gone = rows[index]!;
  await act(async () => { await run(view.actions(), gone); });
  const others = rows.filter((row) => row !== gone).map((row) => row.room.id);
  expect(view.visible()).toEqual(others);
  // Search narrows the shown rows; the server list still holds the stale row.
  view.rerender(rows, [rows[0]!]);
  expect(view.visible()).toEqual(['a']);
  // Clearing search before the refresh lands must not bring the row back.
  view.rerender(rows);
  expect(view.visible()).toEqual(others);
});
