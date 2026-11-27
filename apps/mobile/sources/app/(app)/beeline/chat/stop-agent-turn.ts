import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { Modal } from '@/modal';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';

/** Ask the server to stop one agent's turn. A failure always shows a dialog and
 * rereads the Room, so a Stop press never ends silently. */
export async function requestAgentTurnStop(
  roomId: string,
  stop: { agentPubkey: string; requestId: string },
  readRoom: () => void,
): Promise<boolean> {
  try {
    await monolithPhoneOperation(
      'cancelAgentTurn',
      {
        roomId,
        requestId: stop.requestId,
        agentId: stop.agentPubkey,
      },
      { recoverSilentSocket: true },
    );
    return true;
  } catch (err) {
    readRoom();
    Modal.alert(
      err instanceof MonolithRequestTimeoutError ? 'Stop result unknown' : 'Stop failed',
      phoneOperationFailureReason(err),
    );
    console.warn('Stopping the turn failed:', err);
    return false;
  }
}
