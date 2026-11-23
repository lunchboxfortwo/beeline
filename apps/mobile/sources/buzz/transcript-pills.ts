import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

/**
 * Pills (build spec, decision 15): an agent's message() to another agent and a
 * stop render as avatar pills (from face → to face, or face ■ face); a tap
 * reads the message. A plain tag stays a message, and every other system line
 * keeps its own `LedgerSystemLine` row.
 * Consecutive pills share one wrapping row, so the transcript folds a run of
 * them into one host row. PR lifecycle runs keep their own counted disclosure.
 */

type PillFields = Pick<
  ChatDisplayMessage,
  | 'deleted' | 'isSystemNotice' | 'isArchivedNotice' | 'awayWarning' | 'authorIdentity' | 'pubkey'
  | 'isAgentActivity' | 'isAgentDraft' | 'isAgentLiveTurn' | 'attachments' | 'agentCommand' | 'cornerMarkers'
  | 'vaultSave' | 'roomUpdate' | 'writePermission' | 'grantRequest' | 'squireApproval' | 'computerSession'
  | 'voiceCall' | 'onboarding' | 'choice' | 'appSignIn' | 'agentSignIn' | 'connectorOffer'
  | 'notificationLifecycleRun' | 'walletTx' | 'walletInsufficient' | 'walletDelegation'
  | 'targetBranchProposal' | 'corner' | 'githubEvent' | 'daemonFact' | 'systemEvent'
>;

/** A row that the transcript draws as a card or nothing, never as a pill. */
function ownsCard(message: PillFields): boolean {
  return Boolean(
    message.deleted || message.isArchivedNotice || message.awayWarning || message.cornerMarkers?.length ||
    message.vaultSave || message.roomUpdate || message.writePermission || message.grantRequest ||
    message.squireApproval || message.computerSession || (message.voiceCall && !message.voiceCall.endedAt) ||
    message.onboarding || message.choice || message.appSignIn || message.agentSignIn || message.connectorOffer ||
    message.notificationLifecycleRun || message.walletTx || message.walletInsufficient ||
    message.walletDelegation || message.targetBranchProposal || message.corner || message.githubEvent ||
    message.daemonFact || message.isAgentActivity || message.isAgentDraft || message.isAgentLiveTurn ||
    message.attachments?.length,
  );
}

/** A server-phrased notice or a Beeline-account row: drawn by `LedgerSystemLine`, never as a pill. */
export function isSystemLine(message: PillFields): boolean {
  return Boolean(message.isSystemNotice) || (message.authorIdentity?.pubkey ?? message.pubkey) === SYSTEM_IDENTITY_PUBKEY;
}

/**
 * A folded PR / thread lifecycle run (its rows read inside the opened card),
 * a stop of an agent's turn, or an agent's message to another agent.
 */
export function isPillMessage(message: PillFields): boolean {
  if (message.notificationLifecycleRun && !message.deleted) return true;
  if (ownsCard(message)) return false;
  if (stopNotice(message)) return true;
  const author = message.authorIdentity?.pubkey ?? message.pubkey;
  return message.agentCommand?.recipient.kind === 'agent' && Boolean(author) && author !== SYSTEM_IDENTITY_PUBKEY;
}

/** Fold consecutive avatar pills into `pillRun`; lifecycle disclosures and lone pills stay separate. */
export function foldPillRuns(messages: readonly ChatDisplayMessage[]): ChatDisplayMessage[] {
  const result: ChatDisplayMessage[] = [];
  let run: ChatDisplayMessage[] = [];
  const flush = () => {
    if (run.length > 1) {
      const anchor = run[0]!;
      const ids = run.flatMap((message) => message.foldedIds ?? [message.id]);
      const boundaries = run.flatMap((message) =>
        message.foldedReadBoundaries ??
        [{ id: message.id, orderAtMs: message.orderAtMs ?? message.timestamp * 1_000 }]);
      result.push({
        ...anchor,
        timestamp: run.at(-1)!.timestamp,
        foldedIds: ids,
        foldedReadBoundaries: boundaries,
        pillRun: run,
      });
    } else if (run.length === 1) {
      result.push(run[0]!);
    }
    run = [];
  };
  for (const message of messages) {
    // Lifecycle runs already own a counted disclosure; keep it visible between pills.
    if (isPillMessage(message) && !message.notificationLifecycleRun) {
      run.push(message);
      continue;
    }
    flush();
    result.push(message);
  }
  flush();
  return result;
}

/** A stop of an agent's turn, with who stopped whom, when the line names both. */
export function stopNotice(message: Pick<ChatDisplayMessage, 'systemEvent'>):
  { stopper: { id: string; name: string; kind: 'agent' | 'human' }; stopped: { id: string; name: string } } | undefined {
  const event = message.systemEvent;
  if (event?.kind !== 'turn-cancelled' || !event.subject.id || !event.object?.id) return undefined;
  if (event.subject.kind !== 'person' && event.subject.kind !== 'agent') return undefined;
  return {
    stopper: { id: event.subject.id, name: event.subject.name, kind: event.subject.kind === 'agent' ? 'agent' : 'human' },
    stopped: { id: event.object.id, name: event.object.text },
  };
}
