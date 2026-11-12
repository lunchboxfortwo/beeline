import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

/**
 * Pills (build spec, decision 15): system messages and agent-to-agent messages
 * render as avatar-only pills (from face → to face); a tap reads the message.
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
  | 'targetBranchProposal' | 'corner' | 'githubEvent' | 'daemonFact' | 'mentionPubkeys' | 'isAgentAuthor'
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

/**
 * A system line (from the Beeline account), a folded PR / thread lifecycle
 * run (a system notice; its rows read inside the opened pill), or an agent's
 * order/report to another agent.
 */
export function isPillMessage(message: PillFields): boolean {
  if (message.notificationLifecycleRun && !message.deleted) return true;
  if (ownsCard(message)) return false;
  if (message.agentCommand) return message.agentCommand.recipient.kind === 'agent';
  if (message.isSystemNotice) return true;
  return (message.authorIdentity?.pubkey ?? message.pubkey) === SYSTEM_IDENTITY_PUBKEY;
}

/** An agent author whose message mentions only agents. */
export function isAgentToAgentMessage(message: PillFields, knownAgentPubkeys: ReadonlySet<string>): boolean {
  if (ownsCard(message)) return false;
  if (message.agentCommand) return message.agentCommand.recipient.kind === 'agent';
  const author = message.authorIdentity?.pubkey ?? message.pubkey;
  const agentAuthor = message.authorIdentity?.kind === 'agent' ||
    Boolean(message.isAgentAuthor) || Boolean(author && knownAgentPubkeys.has(author));
  const mentions = message.mentionPubkeys ?? [];
  return agentAuthor && mentions.length > 0 && mentions.every((pubkey) => pubkey !== author && knownAgentPubkeys.has(pubkey));
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
