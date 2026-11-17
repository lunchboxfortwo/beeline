import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import type { SqlDatabase } from './database.js';


export type WorkflowWakeCard = {
  runId?: string;
  workflowSlug?: string;
  note?: string;
  seq?: number;
  receiptHint?: string;
  choiceId?: string;
  /** A gate answer's transition card carries the person's note in its contents. */
  contents?: { note?: unknown };
};

/** Resolve the pinned run once at enqueue; queue reads deliver this snapshot. */
export async function queuedWorkflowWakeDetail(
  db: SqlDatabase, roomId: string,
  source: { room_id: string; card_type?: string; card?: WorkflowWakeCard } | null,
  sourceMessageId: string | null, resumeSourceMessageId?: string | null,
): Promise<string> {
  if (!(source?.room_id === roomId && (source.card?.runId || source.card?.choiceId)) && !resumeSourceMessageId) return '';
  const context = (await db.query<{
    card_type: string | null; card: WorkflowWakeCard | null; state: string | null;
    outcomes: Record<string, string> | null; status: string | null; receipt_hint: string | null;
  }>(`WITH wake AS (
    SELECT CASE WHEN source.card->>'runId' IS NOT NULL THEN source.card_type
        WHEN resume_source.card->>'runId' IS NOT NULL THEN resume_source.card_type ELSE source.card_type END card_type,
      CASE WHEN source.card->>'runId' IS NOT NULL THEN source.card
        WHEN resume_source.card->>'runId' IS NOT NULL THEN resume_source.card ELSE source.card END card
    FROM (SELECT 1) anchor
    LEFT JOIN messages source ON source.id=$2 AND source.room_id=$1
    LEFT JOIN messages resume_source ON resume_source.id=$3 AND resume_source.room_id=$1
  ) SELECT wake.card_type,wake.card,latest.card->>'toState' state,
    pinned.markdown::jsonb->'handoffs'->(latest.card->>'toState')->'on' outcomes,
    NULLIF(start.card->>'runStatus','live') status,
    CASE WHEN latest.card IS NOT NULL THEN pinned.markdown::jsonb->'handoffs'->(latest.card->>'toState')->>'hint'
      ELSE COALESCE(wake.card->>'receiptHint',choice_message.card->>'receiptHint') END receipt_hint
    FROM wake
    LEFT JOIN room_choices choice ON choice.id::text=wake.card->>'choiceId' AND choice.room_id=$1
    LEFT JOIN messages choice_message ON choice_message.id=choice.message_id AND choice_message.room_id=$1
    LEFT JOIN LATERAL (
      SELECT card FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
        AND card->>'runId'=COALESCE(wake.card->>'runId',choice_message.card->>'runId')
      ORDER BY (card->>'seq')::int DESC NULLS LAST,created_at DESC,id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN messages start ON start.id=latest.card->>'runId' AND start.room_id=$1
    LEFT JOIN rooms room ON room.id=$1
    LEFT JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id
      AND skill.slug=latest.card->>'workflowSlug' AND skill.kind='workflow'
    LEFT JOIN workspace_skill_versions pinned ON pinned.skill_id=skill.id
      AND pinned.version=(latest.card->>'workflowVersion')::int`,
    [roomId,sourceMessageId,resumeSourceMessageId ?? null])).rows[0];
  if (!context) return '';
  return workflowWakeDetail(context.card_type,context.card,context.state,context.outcomes,context.status) +
    (context.receipt_hint ? `\nReceipt hint for this state: ${context.receipt_hint}. Attach an optional receipt when you call handoff.` : '');
}


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
