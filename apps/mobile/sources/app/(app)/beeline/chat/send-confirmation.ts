import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { AgentMessageWriteResult, RoomViewAgentTurn } from '@beeline/api-contract/phone';
import { STEER_RECEIVED_VISIBLE_MS, hasComposerAckReceipt, type PendingComposerAck } from '@/buzz/room-indicators';
import { useComposerAckExpiry } from '@/buzz/use-composer-ack-expiry';

type ReceivedSteer = { agentPubkey: string; turnRequestId: string; receivedAt: number };
type Setter<T> = Dispatch<SetStateAction<T>>;

export function useSendConfirmationState() {
  // Armed the instant a message this client believes addresses an agent is
  // sent, so the composer never shows dead air waiting on the real WORKING
  // receipt (API write + pickup + receipt + refetch). See
  // `selectComposerAckPresentation`.
  const [pendingAck, setPendingAck] = useState<PendingComposerAck | null>(null);

  const [receivedSteer, setReceivedSteer] = useState<{
    agentPubkey: string;
    turnRequestId: string;
    receivedAt: number;
  } | null>(null);

  return { pendingAck, setPendingAck, receivedSteer, setReceivedSteer };
}

/** Server receipts and deadlines retire local confirmation, never committed turns. */
export function useSendConfirmationReceipts(
  pendingAck: PendingComposerAck | null,
  setPendingAck: Setter<PendingComposerAck | null>,
  receivedSteer: ReceivedSteer | null,
  setReceivedSteer: Setter<ReceivedSteer | null>,
  agentTurnMarkers: readonly RoomViewAgentTurn[],
  activeAgentTurn: RoomViewAgentTurn | null,
) {
  // Once the matching server-indexed receipt lands there is nothing left for
  // the local ack to guess at. A terminal receipt is still confirmation: the
  // old active-only check missed the case where WORKING had already become
  // COMPLETE before this screen observed it.
  useEffect(() => {
    if (pendingAck && !pendingAck.externalHandles?.length && hasComposerAckReceipt(pendingAck.requestId, agentTurnMarkers)) {
      setPendingAck(null);
    }
  }, [agentTurnMarkers, pendingAck]);


  useComposerAckExpiry(pendingAck, setPendingAck);

  // A committed steer is a brief confirmation, not a new lifecycle. It stays
  // on the exact running turn the server accepted it into and then clears.
  useEffect(() => {
    if (!receivedSteer) return;
    if (
      !activeAgentTurn ||
      activeAgentTurn.agentPubkey !== receivedSteer.agentPubkey ||
      activeAgentTurn.requestId !== receivedSteer.turnRequestId
    ) {
      setReceivedSteer(null);
      return;
    }
    const delay = Math.max(
      1,
      receivedSteer.receivedAt + STEER_RECEIVED_VISIBLE_MS - Date.now() + 1,
    );
    const timer = setTimeout(() => setReceivedSteer(null), delay);
    return () => clearTimeout(timer);
  }, [activeAgentTurn, receivedSteer]);

}

/** Named send steps share the same confirmation policy across every viewport. */
export function createSendConfirmation({
  setPendingAck, setReceivedSteer, setSending, desktopExperience, setDesktopDeliveryState,
}: {
  setPendingAck: Setter<PendingComposerAck | null>;
  setReceivedSteer: Setter<ReceivedSteer | null>;
  setSending: Setter<boolean>;
  desktopExperience: boolean;
  setDesktopDeliveryState: Setter<'failed' | 'sending' | 'delivered' | null>;
}) {
  return {
    begin(addressesAgent: boolean) {
      setReceivedSteer(null);
      setPendingAck(addressesAgent ? { sentAt: Date.now() } : null);
      setSending(true);
      if (desktopExperience) setDesktopDeliveryState('sending');
    },
    signed(requestId: string, addressesAgent: boolean) {
      if (addressesAgent) setPendingAck(current => current ? { ...current, requestId } : current);
    },
    accepted(requestId: string, result: Pick<AgentMessageWriteResult, 'externalAgentHandles' | 'activeSteerAgentIds'>,
      isCorner: boolean, activeAgentTurn: RoomViewAgentTurn | null) {
      if (isCorner && activeAgentTurn && result.activeSteerAgentIds?.includes(activeAgentTurn.agentPubkey)) {
        setReceivedSteer({ agentPubkey: activeAgentTurn.agentPubkey,
          turnRequestId: activeAgentTurn.requestId, receivedAt: Date.now() });
      }
      if (desktopExperience) setDesktopDeliveryState('delivered');
      const acceptedAt = Date.now();
      setPendingAck(current => result.externalAgentHandles?.length
        ? { sentAt: acceptedAt, requestId, externalHandles: result.externalAgentHandles }
        : current && (current.requestId === undefined || current.requestId === requestId) ? null : current);
    },
    cancelled() {
      setPendingAck(null);
      if (desktopExperience) setDesktopDeliveryState(null);
    },
    pending() {
      if (desktopExperience) setDesktopDeliveryState(null);
    },
    failed() {
      if (desktopExperience) setDesktopDeliveryState('failed');
      setPendingAck(null);
    },
    finished() { setSending(false); },
  };
}
