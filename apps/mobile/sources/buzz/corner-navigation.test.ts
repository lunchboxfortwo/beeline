import { describe, expect, it, vi } from 'vitest';
import {
  messageJumpHref,
  chatBackAction,
  cornerOpenAction,
  cornerHref,
  navigateToRoom,
  resolveMentionDirectMessageAction,
  roomHref,
  routeChannelId,
  type ChatStackRoute,
} from './corner-navigation';

const chatRoute = (channelId: string): ChatStackRoute => ({
  name: 'beeline/chat/[channelId]',
  params: { channelId },
});

describe('opening a corner', () => {
  it('cannot silently no-op', () => {
    expect(cornerOpenAction('corner-1', 'room-1')).toEqual({
      type: 'open-corner',
      cornerId: 'corner-1',
    });
    expect(cornerOpenAction(undefined, 'room-1')).toMatchObject({ type: 'explain' });
    expect(cornerOpenAction('', 'room-1')).toMatchObject({ type: 'explain' });
    expect(cornerOpenAction('room-1', 'room-1')).toMatchObject({ type: 'explain' });
  });
});

describe('leaving a corner', () => {
  it('goes back to the parent Room it was opened from', () => {
    const routes = [{ name: 'beeline/channels' }, chatRoute('room-1'), chatRoute('corner-1')];
    expect(chatBackAction(routes, 'room-1')).toEqual({ type: 'back' });
  });

  it('returns to the Room it was opened from after a notification reordered the stack', () => {
    // A notification's `dangerouslySingular` navigate can leave a corner below
    // its own Room. A corner drilled into from that Room still returns to it.
    const routes = [
      { name: 'beeline/channels' },
      chatRoute('corner-1'),
      chatRoute('room-1'),
      chatRoute('corner-1'),
    ];
    expect(chatBackAction(routes, 'room-1')).toEqual({ type: 'back' });

    const landedOn = routes[routes.length - 2];
    expect(routeChannelId(landedOn)).toBe('room-1');
    expect(routeChannelId(landedOn)).not.toBe('corner-1');
  });

  it('skips another thread to reach the parent chat', () => {
    expect(chatBackAction([chatRoute('room-1'), chatRoute('corner-1'), chatRoute('corner-2')], 'room-1'))
      .toEqual({ type: 'pop', count: 2 });
  });

  it('skips copies of itself stacked on top', () => {
    const routes = [chatRoute('room-1'), chatRoute('corner-1'), chatRoute('corner-1')];
    expect(chatBackAction(routes, 'room-1')).toEqual({ type: 'pop', count: 2 });
  });

  it('opens the parent Room when nothing is underneath', () => {
    expect(chatBackAction([chatRoute('corner-1')], 'room-1')).toEqual({
      type: 'open-room',
      channelId: 'room-1',
    });
  });

  it('ignores an old Room-list return hint on a thread', () => {
    expect(chatBackAction([{ name: 'beeline/channels' }, chatRoute('corner-1')], 'room-1', 'room-list'))
      .toEqual({ type: 'open-room', channelId: 'room-1' });
  });

  it('reads a channel id through URI encoding', () => {
    expect(routeChannelId({ params: { channelId: 'a%2Fb' } })).toBe('a/b');
    expect(routeChannelId({ params: { channelId: '100%' } })).toBe('100%');
    expect(routeChannelId({ params: {} })).toBeUndefined();
    expect(routeChannelId(undefined)).toBeUndefined();
  });
});

describe('leaving a Room', () => {
  it('goes back normally when there is something to go back to', () => {
    expect(chatBackAction([{ name: 'beeline/channels' }, chatRoute('room-1')], undefined)).toEqual({
      type: 'back',
    });
  });

  it('falls back to the Room list instead of a back that does nothing', () => {
    expect(chatBackAction([chatRoute('room-1')], undefined)).toEqual({ type: 'room-list' });
    expect(chatBackAction([], undefined)).toEqual({ type: 'room-list' });
  });

  it('leaves on the first back when the same Room was pushed twice', () => {
    // PR 1490 mounts the real Room on tap with no covering pixel and
    // animation:none. A second push of the same channel (double tap, or
    // navigate that became a push) leaves channels → room → room. A single
    // back then lands in the Room the reader just tried to leave.
    const routes = [{ name: 'beeline/channels' }, chatRoute('room-1'), chatRoute('room-1')];
    expect(chatBackAction(routes, undefined)).toEqual({ type: 'pop', count: 2 });
  });

  it('does not wait for a later press when three copies sit on top of the list', () => {
    const routes = [
      { name: 'beeline/channels' },
      chatRoute('room-1'),
      chatRoute('room-1'),
      chatRoute('room-1'),
    ];
    expect(chatBackAction(routes, undefined)).toEqual({ type: 'pop', count: 3 });
  });

  it('still pops one when the Room under the top is a different channel', () => {
    const routes = [{ name: 'beeline/channels' }, chatRoute('room-1'), chatRoute('room-2')];
    expect(chatBackAction(routes, undefined)).toEqual({ type: 'back' });
  });
});

describe('leaving a screen opened from a notification', () => {
  it('sends a Room to the Room list, not the screen underneath', () => {
    const routes = [
      { name: 'beeline/channels' },
      chatRoute('room-2'),
      chatRoute('corner-9'),
      chatRoute('room-1'),
    ];
    expect(chatBackAction(routes, undefined, 'room-list')).toEqual({ type: 'pop', count: 3 });
    expect(chatBackAction([chatRoute('room-1')], undefined, 'room-list')).toEqual({
      type: 'room-list',
    });
  });
});

describe('corner hrefs', () => {
  it('carries the parent and known title so the corner header is right on frame one', () => {
    expect(cornerHref('corner-1', 'room-1', 'fix-oauth-callback')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'corner-1', parent: 'room-1', title: 'fix-oauth-callback' },
    });
  });

  it('omits an unknown title rather than passing an empty one', () => {
    expect(cornerHref('corner-1', 'room-1')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'corner-1', parent: 'room-1' },
    });
  });

  it('opens a Room with no corner hints attached', () => {
    expect(roomHref('room-1')).toEqual({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-1' },
    });
  });

  it('reuses an existing Room copy instead of pushing a second one', () => {
    const navigate = vi.fn();
    navigateToRoom({ navigate }, 'room-1');
    expect(navigate).toHaveBeenCalledWith(roomHref('room-1'), { dangerouslySingular: true });
  });
});

describe('opening a resolved member mention', () => {
  it('resolves the deterministic Workspace DM and opens the returned Room', async () => {
    const resolveDirectMessage = vi.fn(async () => ({ channelId: 'dm-1', created: true }));

    await expect(
      resolveMentionDirectMessageAction(resolveDirectMessage, 'workspace-1', 'member-1', 'room-1'),
    ).resolves.toEqual({ type: 'open-room', channelId: 'dm-1' });
    expect(resolveDirectMessage).toHaveBeenCalledWith('workspace-1', 'member-1');
  });

  it('stays put when the resolved DM is already on screen', async () => {
    const resolveDirectMessage = vi.fn(async () => ({ channelId: 'dm-1', created: false }));

    await expect(
      resolveMentionDirectMessageAction(resolveDirectMessage, 'workspace-1', 'member-1', 'dm-1'),
    ).resolves.toEqual({ type: 'stay' });
  });
});

it('R12g: message jumps preserve the notification target and response id', () => {
  expect(messageJumpHref('room', 'message', 'response')).toEqual({
    pathname: '/beeline/chat/[channelId]',
    params: {
      channelId: 'room',
      notificationMessageId: 'message',
      notificationResponseId: 'response',
    },
  });
});

it('a distant bookmark keeps its exact target and response identity', () => {
  const target = 'b'.repeat(64);
  expect(messageJumpHref('room', target, `bookmark:${target}`, 'workspace').params).toEqual({
    channelId: 'room',
    notificationMessageId: target,
    notificationResponseId: `bookmark:${target}`,
    communityId: 'workspace',
  });
});
