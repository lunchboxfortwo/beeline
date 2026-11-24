import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { isGitHubLifecycleItem } from '@/buzz/pr-lifecycle';

type PillFields = Pick<
  ChatDisplayMessage,
  | 'deleted' | 'isSystemNotice' | 'isArchivedNotice' | 'awayWarning' | 'authorIdentity' | 'pubkey'
  | 'isAgentActivity' | 'isAgentDraft' | 'isAgentLiveTurn' | 'attachments' | 'agentCommand' | 'cornerMarkers'
  | 'vaultSave' | 'roomUpdate' | 'writePermission' | 'grantRequest' | 'squireApproval' | 'computerSession'
  | 'voiceCall' | 'onboarding' | 'choice' | 'appSignIn' | 'agentSignIn' | 'connectorOffer'
  | 'notificationLifecycleRun' | 'walletTx' | 'walletInsufficient' | 'walletDelegation'
  | 'targetBranchProposal' | 'corner' | 'githubEvent' | 'daemonFact' | 'systemEvent'
  | 'systemTranscript' | 'durableFact' | 'presentation'
>;

function hasCardBody(message: PillFields): boolean {
  return !message.deleted && Boolean(
    message.systemTranscript?.visibility === 'card' || message.vaultSave || message.roomUpdate ||
    message.writePermission || message.grantRequest || message.squireApproval || message.computerSession ||
    message.onboarding || message.choice || message.appSignIn || message.agentSignIn || message.connectorOffer ||
    message.notificationLifecycleRun || message.walletTx || message.walletInsufficient ||
    message.walletDelegation || message.targetBranchProposal || message.githubEvent || message.daemonFact ||
    message.awayWarning,
  );
}

export function isSystemLine(message: PillFields): boolean {
  const author = message.authorIdentity?.pubkey ?? message.pubkey;
  if (message.systemTranscript || message.deleted || message.systemEvent || message.presentation === 'system' ||
      author === SYSTEM_IDENTITY_PUBKEY || author === SCHEDULE_SCHEDULER_ID) return true;
  // Legacy report records sometimes carry the notice flag. Their speech keeps
  // the recorded agent and the recipient's ordinary reply affordances.
  if (message.agentCommand?.kind === 'report') return false;
  return Boolean(
    message.isSystemNotice ||
    message.durableFact || message.githubEvent || message.daemonFact || message.roomUpdate ||
    message.awayWarning || message.grantRequest || message.squireApproval || message.agentSignIn ||
    message.appSignIn || message.connectorOffer || message.writePermission || message.targetBranchProposal ||
    message.computerSession || message.vaultSave || message.walletTx || message.walletInsufficient ||
    message.walletDelegation || message.onboarding || message.voiceCall,
  );
}

/** Some retained records drive the header or agent context and have no transcript body. */
export function isHiddenSystemLine(message: PillFields): boolean {
  if (message.systemTranscript?.visibility === 'hidden') return true;
  if (message.deleted) return false;
  const kind = message.systemEvent?.kind;
  return kind === 'schedule-ran' ||
    kind === 'computer-session-activity' || kind === 'connector-offer-decided' ||
    kind === 'squire-approval-decided' || kind === 'grant-decided' ||
    Boolean(message.voiceCall && !message.voiceCall.endedAt);
}

export function isPillMessage(message: PillFields): boolean {
  if (isHiddenSystemLine(message) || message.isArchivedNotice || message.corner) return false;
  if (message.notificationLifecycleRun || isSystemLine(message)) return true;
  if (hasCardBody(message) || message.cornerMarkers?.length || message.isAgentActivity ||
      message.isAgentDraft || message.isAgentLiveTurn || message.attachments?.length) return false;
  const author = message.authorIdentity?.pubkey ?? message.pubkey;
  return message.agentCommand?.recipient.kind === 'agent' && Boolean(author);
}

/** A folded lifecycle run of GitHub and thread events only: it folds with agent pills. */
export function isGitHubEventRun(message: Pick<ChatDisplayMessage, 'notificationLifecycleRun' | 'deleted'>): boolean {
  const items = message.notificationLifecycleRun?.items;
  return Boolean(items?.length && !message.deleted && items.every(isGitHubLifecycleItem));
}

/** Fold consecutive avatar pills and GitHub event runs into `pillRun`; payment runs and lone pills stay separate. */
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
    // New notice bodies retain their own row, including any actions or markers.
    if (isPillMessage(message) && !message.cornerMarkers?.length &&
        (isGitHubEventRun(message) || Boolean(stopNotice(message)) ||
          (!isSystemLine(message) && !message.notificationLifecycleRun))) {
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
export function stopNotice(message: Pick<ChatDisplayMessage, 'systemEvent' | 'deleted'>):
  { stopper: { id: string; name: string; kind: 'agent' | 'human' }; stopped: { id: string; name: string } } | undefined {
  const event = message.systemEvent;
  if (message.deleted || event?.kind !== 'turn-cancelled' || !event.subject.id || !event.object?.id) return undefined;
  if (event.subject.kind !== 'person' && event.subject.kind !== 'agent') return undefined;
  return {
    stopper: { id: event.subject.id, name: event.subject.name, kind: event.subject.kind === 'agent' ? 'agent' : 'human' },
    stopped: { id: event.object.id, name: event.object.text },
  };
}
