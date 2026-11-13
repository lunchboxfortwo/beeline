import {
  cornerShortTitle,
  roomTitle,
  type NeedsYouActionView,
  type NeedsYouApprovalView,
  type NeedsYouItemView,
} from '@beeline/api-contract/phone';

/** Where a card was sent: the chat, then the thread when it came from one. */
export function tagPlace(item: NeedsYouItemView): { chat: string; thread?: string } {
  if (item.roomKind === 'corner')
    return {
      chat: roomTitle(item.parentRoomName) ?? '',
      thread: cornerShortTitle(item.parentRoomName, item.roomName, item.roomId),
    };
  if (item.roomKind === 'room') return { chat: roomTitle(item.roomName) ?? item.roomName };
  // A DM is named after the other person.
  return { chat: item.roomName };
}

/**
 * The card's sentence: `<who> tagged you:` over a plain tag, `<agent> asks:`
 * over a question with a decision or a Trusty Squire request, otherwise the
 * server's own verb phrase (`Hoots wants to run a command`) over the exact
 * thing asked for.
 */
export function tagSentence(item: NeedsYouItemView): { lead: string; text: string; literal: boolean } {
  const approval = item.approval;
  if (!approval && item.addressedReport)
    return { lead: item.author?.name ? `${item.author.name} needs your decision:` : 'Needs your decision:', text: item.text, literal: false };
  if (!approval)
    return { lead: item.author?.name ? `${item.author.name} tagged you:` : '', text: item.text, literal: false };
  if (approval.kind === 'merge') return { lead: `${approval.actor} asks:`, text: item.text, literal: false };
  if (approval.kind === 'choice') return { lead: `${approval.actor} asks:`, text: approval.subject, literal: false };
  if (approval.kind === 'squire') {
    const ask = approval.subject;
    return { lead: `${approval.actor} asks:`, text: ask.charAt(0).toUpperCase() + ask.slice(1), literal: false };
  }
  return { lead: `${approval.actor} ${approval.ask}`, text: approval.subject, literal: approval.literal };
}

/** What Approve or Deny does: an existing decision operation, the merge yes, or a dismissal. */
export type TagDecision =
  | { readonly kind: 'action'; readonly action: NeedsYouActionView }
  | { readonly kind: 'merge' }
  | { readonly kind: 'dismiss' };

const actions = (approval: NeedsYouApprovalView) => approval.actions ?? [];

/**
 * Approve for each kind, or null when the card has no inline decision
 * (connector offers and sign-ins decide in their chat). A grant approves once
 * where it can; a choice approves the picked option; Trusty Squire always
 * opens its own approval page.
 */
export function approveDecision(item: NeedsYouItemView, optionId?: string): TagDecision | null {
  const approval = item.approval;
  if (!approval) return null;
  if (approval.kind === 'merge') return { kind: 'merge' };
  const find = (match: (action: NeedsYouActionView) => boolean) => {
    const action = actions(approval).find(match);
    return action ? { kind: 'action' as const, action } : null;
  };
  switch (approval.kind) {
    case 'grant':
      return find((a) => a.kind === 'grant' && a.decision === 'once') ??
        find((a) => a.kind === 'grant' && a.decision === 'always');
    case 'write-access':
      return find((a) => a.kind === 'write-access' && a.decision === 'allow');
    case 'choice':
      return optionId ? find((a) => a.kind === 'choice' && a.optionId === optionId) : null;
    case 'squire':
      return find((a) => a.kind === 'external');
    default:
      return null;
  }
}

/**
 * Deny for each kind. A merge ask has no refusal operation, so Deny dismisses
 * it from Tags; a choice skips when it may; Trusty Squire denies on its own page.
 */
export function denyDecision(item: NeedsYouItemView): TagDecision | null {
  const approval = item.approval;
  if (!approval) return null;
  if (approval.kind === 'merge') return { kind: 'dismiss' };
  const action = actions(approval).find((a) =>
    a.kind === 'grant' || a.kind === 'write-access' ? a.decision === 'deny'
      : a.kind === 'skip-choice' ? true
        : a.kind === 'external');
  return action ? { kind: 'action', action } : null;
}

/** The pull request's check line, from what the corner recorded. */
export function checksLine(checks: NonNullable<NeedsYouApprovalView['pullRequest']>['checks']): string | null {
  if (!checks) return null;
  switch (checks.status) {
    case 'passing':
      return checks.total ? `All ${checks.total} checks passed` : 'All checks passed';
    case 'failing':
      return checks.failing && checks.total ? `${checks.failing} of ${checks.total} checks failed` : 'Checks failed';
    case 'pending':
      return 'Checks running';
    default:
      return null;
  }
}

/**
 * A Trusty Squire request's evidence: "Trusty Squire · <card>", then the other
 * facts' values (merchant · amount), then what it is for.
 */
export function squireEvidence(approval: NeedsYouApprovalView): { source: string; headline: string; purpose?: string } {
  const facts = approval.facts ?? [];
  const card = facts.find((fact) => /card/i.test(fact.label));
  return {
    source: card ? `Trusty Squire · ${card.value}` : 'Trusty Squire',
    headline: facts.filter((fact) => fact !== card).map((fact) => fact.value).join(' · '),
    purpose: approval.purpose ?? approval.detail,
  };
}
