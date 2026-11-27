import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { RoomViewAgentTurn } from '@beeline/api-contract/phone';
const { operation, alert, MonolithRequestTimeoutError } = vi.hoisted(() => ({
  operation: vi.fn(),
  alert: vi.fn(),
  MonolithRequestTimeoutError: class extends Error {},
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Warning: 'warning' },
}));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: () => 0, useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock('react-native-reanimated', () => ({ useAnimatedStyle: (fn: () => unknown) => fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: (...args: unknown[]) => alert(...args) } }));
vi.mock('@/auth/monolith-session', () => ({ MonolithRequestTimeoutError }));
vi.mock('./send-confirmation', () => ({ useSendConfirmationReceipts: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: (...args: unknown[]) => operation(...args),
  phoneOperationFailureReason: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
import { useChatTurnPresentation } from './useChatTurnPresentation';

beforeEach(() => {
  operation.mockReset();
  alert.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});

it.each([true, false])('resolves an offscreen parent on the first reply render (sender=%s)', (isUser) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const parent: ChatDisplayMessage = { id: 'turn:parent', relayId: 'parent', text: 'Original quote', timestamp: 1, isUser: false };
  const reply: ChatDisplayMessage = { id: 'reply', text: 'Answer', timestamp: 2, isUser, replyToId: 'parent' };
  const no = () => undefined;
  const scroll = { isPinnedToTail: () => true, isUserDragging: () => false, follow: no };
  let index!: Map<string, ChatDisplayMessage>;
  function Harness() {
    const args = [[reply], null, [], no, null, undefined, no, false, null, 'viewer', new Map(), new Map(),
      { bottom: 0 }, 0, scroll, 'room', no, false, no, {}, no, 0, [parent, reply]];
    [, , index] = useChatTurnPresentation(args as unknown as Parameters<typeof useChatTurnPresentation>[0]);
    return <blockquote>{index.get(reply.replyToId!)?.text}</blockquote>;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Harness />); });
  try {
    expect(tree.root.findByType('blockquote').props.children).toBe('Original quote');
    expect(index.get(parent.id)).toBe(parent);
  } finally { act(() => tree.unmount()); }
});

function renderStopHarness(readRoom: () => void | Promise<void>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const no = () => undefined;
  const scroll = { isPinnedToTail: () => true, isUserDragging: () => false, follow: no };
  const workingTurn: RoomViewAgentTurn = {
    agentPubkey: 'carbon',
    requestId: 'req-1',
    generationId: 'gen-1',
    status: 'working',
    createdAt: 1_000,
    startedAt: 1_000,
  };
  const roomSurface = { viewer: { permissions: { send: true } }, pendingAgentCommands: [] };
  const identities = new Map([['carbon', { pubkey: 'carbon', kind: 'agent', name: 'Carbon', handle: 'carbon' }]]);
  let latestStopping = false;
  let latestHandleStop!: (stop: { agentPubkey: string; requestId: string }) => Promise<boolean>;
  function Harness({ active }: { active: RoomViewAgentTurn | undefined }) {
    const markers = active ? [active] : [{ ...workingTurn, status: 'cancelled' as const }];
    const args = [[], null, markers, no, null, active, no, true, roomSurface, 'viewer', identities, new Map(),
      { bottom: 0 }, 0, scroll, 'room-a', readRoom, false, no, {}, no, 0, []];
    [, , , , , , latestStopping, latestHandleStop] = useChatTurnPresentation(
      args as unknown as Parameters<typeof useChatTurnPresentation>[0],
    );
    return <span data-stopping={String(latestStopping)} />;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Harness active={workingTurn} />); });
  return {
    stopTarget: { agentPubkey: 'carbon', requestId: 'req-1' },
    stopping: () => latestStopping,
    handleStop: () => latestHandleStop,
    clearTurn: () => act(() => { tree.update(<Harness active={undefined} />); }),
    unmount: () => act(() => { tree.unmount(); }),
  };
}

it('clears stopping state and rereads the Room when Stop times out', async () => {
  let rejectStop!: (err: unknown) => void;
  operation.mockReturnValue(new Promise((_, reject) => { rejectStop = reject; }));
  const readRoom = vi.fn();
  const harness = renderStopHarness(readRoom);
  try {
    let pending!: Promise<boolean>;
    act(() => { pending = harness.handleStop()(harness.stopTarget); });
    expect(harness.stopping()).toBe(true);
    await act(async () => {
      rejectStop(new MonolithRequestTimeoutError('timed out'));
      expect(await pending).toBe(false);
    });
    expect(harness.stopping()).toBe(false);
    expect(readRoom).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Stop result unknown', 'timed out');
  } finally {
    harness.unmount();
  }
});

it('does not add a Room read when a live turn-delta arrives after Stop succeeds', async () => {
  vi.useFakeTimers();
  operation.mockResolvedValue(undefined);
  const readRoom = vi.fn();
  const harness = renderStopHarness(readRoom);
  try {
    await act(async () => {
      expect(await harness.handleStop()(harness.stopTarget)).toBe(true);
    });
    expect(harness.stopping()).toBe(true);
    harness.clearTurn();
    expect(harness.stopping()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readRoom).not.toHaveBeenCalled();
  } finally {
    harness.unmount();
  }
});

it('reconciles once with readRoom and releases stopping when a live turn-delta is missed after Stop succeeds', async () => {
  vi.useFakeTimers();
  operation.mockResolvedValue(undefined);
  let resolveRead!: () => void;
  const readRoom = vi.fn(() => new Promise<void>((resolve) => { resolveRead = resolve; }));
  const harness = renderStopHarness(readRoom);
  try {
    await act(async () => {
      expect(await harness.handleStop()(harness.stopTarget)).toBe(true);
    });
    expect(harness.stopping()).toBe(true);
    // Still stopping before the bounded reconciliation delay; no premature read.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(readRoom).not.toHaveBeenCalled();
    expect(harness.stopping()).toBe(true);
    // One-shot reconciliation fires once when no live turn-delta arrived.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(readRoom).toHaveBeenCalledTimes(1);
    // Even if the turn is still active when readRoom finishes, stopping releases so Stop is never permanently disabled.
    await act(async () => {
      resolveRead();
      await Promise.resolve();
    });
    expect(harness.stopping()).toBe(false);
    // Never polls again.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(readRoom).toHaveBeenCalledTimes(1);
  } finally {
    harness.unmount();
  }
});
