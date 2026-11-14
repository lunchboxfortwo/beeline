import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';


export type WorkflowWakeCard = {
  runId?: string;
  workflowSlug?: string;
  note?: string;
  seq?: number;
  /** A gate answer's transition card carries the person's note in its contents. */
  contents?: { note?: unknown };
};


/**
 * A Squire decision wake names the exact approval, tool and status, so the
 * woken agent calls that tool's resume step instead of asking again.
 */
export function squireDecisionDetail(cardType: string | null, card: WorkflowWakeCard | null): string {
  if (cardType !== 'squire-approval-decision' || !card) return '';
  const { approvalId, tool, status } = card as { approvalId?: unknown; tool?: unknown; status?: unknown };
  if (typeof approvalId !== 'string' || typeof tool !== 'string' || typeof status !== 'string') return '';
  const next = status === 'approved'
    ? `Call ${tool} with action "resume" and approval_id "${approvalId}" now, then continue the work that needed it.`
    : 'Do not call its resume step.';
  return `\nSquire approval ${approvalId} for ${tool}: ${status}. ${next}`;
}


/**
 * A wake from a saved workflow run (a `workflow-handoff` card, or a gate's
 * choice/poll card once answered — see `postWorkflowGate`) states the run id
 * and workflow name plainly, so a woken agent treats its own wake as proof a
 * run already exists rather than reaching for `start_workflow` again. The
 * corner's lifecycle bookkeeping (`corner-workflow-handoff`) is excluded:
 * every corner turn would otherwise carry this line for no reason, since a
 * corner is never started through `start_workflow`. A gate answer's optional
 * note is quoted ahead of it.
 */
export function workflowWakeDetail(
  cardType: string | null,
  card: WorkflowWakeCard | null,
  state: string | null,
  outcomes: Record<string, string> | null,
  status: string | null,
): string {
  if (!card?.runId || !card.workflowSlug || cardType === CORNER_LIFECYCLE_CARD_TYPE) return '';
  const answerNote = card.note ?? (typeof card.contents?.note === 'string' ? card.contents.note : undefined);
  const note = answerNote ? `\nTheir note with the answer: ${JSON.stringify(answerNote)}` : '';
  const allowed = status ? 'none' : Object.entries(outcomes ?? {})
    .map(([outcome, target]) => `${outcome} -> ${target}`).join(', ') || 'none';
  // A dispatch card's seq is the attempt this wake is for; a later card makes it stale.
  const attempt = cardType === 'workflow-handoff' && !status
    ? `\nThis wake is attempt ${card.seq}: pass "attempt": ${card.seq} to app_tool’s beeline:workflow advance action. Discover its schema with app_tool(app="beeline:workflow") before acting. If you cannot do this step, hand off outcome "blocked" with contents {"reason": "..."} and it moves to the next agent on the role.`
    : '';
  return `${note}\nYou are in run ${card.runId} of ${card.workflowSlug}. Continue this run; do not start a new one.` +
    (state ? `\nCurrent state: ${state}${status ? ` (${status})` : ''}. Allowed outcomes: ${allowed}. Read the pinned contract and requirements with app_tool(app="beeline:workflow", tool="read", args={runId}).` : '') +
    attempt;
}
