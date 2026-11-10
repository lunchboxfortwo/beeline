import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { createSendConfirmation, useSendConfirmationState, useSendConfirmationReceipts } from './send-confirmation';
import type { RoomViewAgentTurn } from '@beeline/api-contract/phone';

let steps: ReturnType<typeof createSendConfirmation>;
let state: ReturnType<typeof useSendConfirmationState>;
let tree: ReturnType<typeof create>;
const turn = { agentPubkey: 'agent', requestId: 'running', status: 'working', createdAt: 90 } as RoomViewAgentTurn;
function Harness({ markers = [], active = null }: { markers?: RoomViewAgentTurn[]; active?: RoomViewAgentTurn | null }) {
  state = useSendConfirmationState();
  const [sending, setSending] = useState(false);
  const [delivery, setDesktopDeliveryState] = useState<'sending' | 'delivered' | 'failed' | null>(null);
  steps = createSendConfirmation({ ...state, setSending, setDesktopDeliveryState, desktopExperience: true });
  useSendConfirmationReceipts(state.pendingAck, state.setPendingAck, state.receivedSteer, state.setReceivedSteer, markers, active);
  const ack = selectComposerAckPresentation({ isCorner: false, now: Date.now(),
    ...(state.pendingAck ? { pendingAckSentAt: state.pendingAck.sentAt, externalHandles: state.pendingAck.externalHandles } : {}) });
  return <output data-sending={sending} data-delivery={delivery}>{ack?.label ?? ''}</output>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  act(() => { tree = create(<Harness />); });
});
afterEach(() => { act(() => tree.unmount()); vi.useRealTimers(); });
const output = () => tree.root.findByType('output').props;

it('begin shows the sending bridge and resets an old steer', () => {
  act(() => { state.setReceivedSteer({ agentPubkey: 'old', turnRequestId: 'old', receivedAt: 100_000 }); steps.begin(true); });
  expect(output().children).toBe('sending…');
  expect(output()['data-sending']).toBe(true);
  expect(output()['data-delivery']).toBe('sending');
  expect(state.receivedSteer).toBeNull();
});
it('signed binds confirmation to the event without reviving an expired bridge', () => {
  act(() => steps.begin(true));
  act(() => steps.signed('message', true));
  expect(state.pendingAck?.requestId).toBe('message');
  act(() => state.setPendingAck(null));
  act(() => steps.signed('late', true));
  expect(state.pendingAck).toBeNull();
});
it('accepted shows external recipients from acceptance time then expires them', () => {
  act(() => steps.begin(true));
  act(() => steps.accepted('message', { externalAgentHandles: ['atlas'] }, false, null));
  expect(output().children).toBe('Sent to @atlas');
  expect(output()['data-delivery']).toBe('delivered');
  act(() => vi.advanceTimersByTime(3000));
  expect(output().children).toBe('');
});
it('accepted retires only its own native bridge and records a steer on its running turn', () => {
  act(() => tree.update(<Harness active={turn} />));
  act(() => steps.begin(true));
  act(() => steps.signed('newer', true));
  act(() => steps.accepted('older', { activeSteerAgentIds: ['agent'] }, true, turn));
  expect(state.pendingAck?.requestId).toBe('newer');
  expect(state.receivedSteer?.turnRequestId).toBe('running');
  act(() => steps.accepted('newer', {}, false, null));
  expect(output().children).toBe('');
});
it('cancelled removes local feedback without claiming delivery', () => {
  act(() => steps.begin(true));
  act(() => steps.cancelled());
  expect(output().children).toBe('');
  expect(output()['data-delivery']).toBeNull();
});
it('pending leaves the bridge alive while delivery is unknown', () => {
  act(() => steps.begin(true));
  act(() => steps.pending());
  expect(output().children).toBe('sending…');
  expect(output()['data-delivery']).toBeNull();
});
it('failed clears confirmation and exposes failure', () => {
  act(() => steps.begin(true));
  act(() => steps.failed());
  expect(output().children).toBe('');
  expect(output()['data-delivery']).toBe('failed');
});
it('finished releases the sending guard without discarding acceptance', () => {
  act(() => steps.begin(true));
  act(() => steps.accepted('message', { externalAgentHandles: ['atlas'] }, false, null));
  act(() => steps.finished());
  expect(output()['data-sending']).toBe(false);
  expect(output().children).toBe('Sent to @atlas');
});
it('receipts retire a matching bridge even when the turn already completed', () => {
  act(() => steps.begin(true));
  act(() => steps.signed('message', true));
  act(() => tree.update(<Harness markers={[{ ...turn, requestId: 'message', status: 'complete' }]} />));
  expect(output().children).toBe('');
});
