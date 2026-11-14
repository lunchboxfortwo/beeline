import { subscriptionActionPrompt, type AgentCommand, type SystemEvent } from '@beeline/api-contract/daemon';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { SCHEDULE_RAN_VERB, SCHEDULE_SCHEDULER_NAME } from '@beeline/api-contract/scheduled-prompts';
import { attachmentMarkerLines } from './attachment-delivery.js';

/**
 * Whether this principal may start a turn. Agents are server-validated Room members
 * and are never gated; a human answers to the agent's access policy.
 *
 * The policy lives on the SERVER (`agent-access.ts`) and its verdict rides on the
 * authority round trip the intake loop already makes per candidate message — so an
 * owner's change in the members page takes effect on a helper that is already
 * running, on its next poll. `humanPermitted` is the runtime record's own reading,
 * used only against a server too old to answer.
 */
/** Server-authored scheduled prompts arrive as system lines (`@scheduler ran a
 *  schedule for <agent> · <message>`) carrying the structured event; the
 *  scheduler is not a Room principal, so its lines skip the per-author
 *  authority check (schedule creation was already authority-gated). Recognised by
 *  the event's verb, never by the text.
 *
 *  Nothing here re-checks that the line is addressed to this agent. An inbox
 *  item exists BECAUSE the server routed it to this agent, so the item IS the
 *  address; asking the line to name the reader again only invites the two to
 *  disagree. */
export function isScheduledPrompt(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): boolean {
  if (item.type !== 'system') return false;
  if (item.systemEvent?.kind) return item.systemEvent.kind === 'schedule-ran';
  // One release of fallback: a line written before the server stamped kinds
  // carries the verb and nothing else. Remove after the next release; the
  // verb is display text and must not be a permanent contract.
  return item.systemEvent?.verb === SCHEDULE_RAN_VERB;
}


/**
 * Who the harness is told an inbox item is from.
 *
 * An event line's subject is the person or agent the fact is ABOUT, and the
 * server put their display name on the structured event. A newcomer's join is
 * the case that needs it: the roster this turn was built from was read before
 * they arrived, so a lookup by author id finds nothing and the greeting comes
 * out addressed to a truncated public key instead of a name.
 */
export function inboxItemAuthorName(
  item: {
    type: string;
    authorId: string;
    body: string;
    systemEvent?: SystemEvent;
  },
  names: ReadonlyMap<string, string>,
): string {
  if (isScheduledPrompt(item)) return SCHEDULE_SCHEDULER_NAME;
  const subject = item.systemEvent?.subject;
  if (item.type === 'system' && subject?.name) return subject.name;
  return names.get(item.authorId) ?? item.authorId.slice(0, 12);
}


/** What the harness is shown for an inbox item: a scheduled prompt's message
 *  itself (the event's consequence), otherwise the row's text. An event line's
 *  own sentence already carries the fact — `Ada joined Beeline Welcome` names
 *  the newcomer — so it is shown as written rather than restated. */
export function inboxItemPromptBody(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): string {
  if (item.systemEvent?.kind === 'subscription-fired') return subscriptionActionPrompt(item.systemEvent);
  return isScheduledPrompt(item) ? (item.systemEvent?.consequence ?? item.body) : item.body;
}

/**
 * The resume prompt for the answer that woke a paused turn. A grant answer and
 * a connector-offer answer resume the same way (`RESUME_KINDS`), but the model
 * must be told which question was answered — the connector one arrives as
 * `<person> added <tool>`, and its right response is to acknowledge and carry
 * on with the work that needed the tool, not to look for a grant verdict.
 */
export function resumePrompt(item: { body: string; systemEvent?: SystemEvent }): string {
  if (item.systemEvent?.kind === 'squire-approval-decided') {
    return [
      `This is Trusty Squire's answer to the approval you were waiting on: ${item.body}.`,
      'Your paused work resumes now.',
      'If it was approved, continue exactly where you left off with Trusty Squire; do not ask the person to approve again, and do not restart the task.',
      'If it was denied, stop that Trusty Squire action and say plainly what you cannot do.',
      'If it got no answer, the approval expired; say so plainly, and ask again only if the person still wants it.',
    ].join(' ');
  }
  if (item.systemEvent?.kind === 'connector-offer-decided') {
    return [
      `This is the answer to your connector offer: ${item.body}.`,
      'Your paused work resumes now. The tool is being installed on your machine; its sign-in and status reach the person through the tool’s own status message, not through you.',
      'Acknowledge in one short line (for example "Adding Trusty Squire now.") and continue the work that needed it, or say plainly what still has to happen before you can.',
    ].join(' ');
  }
  const grant = parseGrantDecisionLine(item.body);
  if (grant?.kind === 'device' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved device ${grant.target} is available to run_granted_command in this session.`,
      'Continue the paused work with it now; do not restart, schedule another turn, or request the device again.',
    ].join(' ');
  }
  if (grant?.kind === 'mcp' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved ${grant.target} route is available through your session tools; read(facet:session) shows its load result.`,
      'Continue the paused work with that tool now; do not restart, schedule another turn, or request the route again.',
    ].join(' ');
  }
  return [
    'This is the answer to your grant request; your paused work resumes now.',
    'If it was approved and it is a command grant, run it with run_granted_command and the exact argv.',
    'If it was declined, try another way or say plainly what you cannot do.',
  ].join(' ');
}

const RESUME_KINDS = new Set(['grant-decided', 'connector-offer-decided', 'squire-approval-decided']);

/**
 * What the session is told for one queue item: who asked, where it came from,
 * where the answer goes, and the message itself. Anything else the agent needs
 * (the conversation, the brief, members, memory) it reads with its own tools.
 */
export function itemPrompt(item: AgentCommand, options: {
  names: ReadonlyMap<string, string>;
  /** Setup steps that failed or were skipped when this session started. */
  notes?: readonly string[];
  /** Session rules for a harness that does not keep a system prompt. */
  turnPrefix?: string;
}): string {
  const source = item.source;
  const author = inboxItemAuthorName(source, options.names);
  const body = source.systemEvent && RESUME_KINDS.has(source.systemEvent.kind ?? '')
    ? resumePrompt(source) : inboxItemPromptBody(source);
  const answerTo = item.returnRoomId === item.roomId
    ? `Your final reply is posted here (${item.roomId}).`
    : `Your final reply is posted to ${item.returnRoomId}.`;
  return [
    ...(options.turnPrefix ? [options.turnPrefix] : []),
    ...(options.notes?.length ? ['Session setup notes:', ...options.notes.map(note => `- ${note}`)] : []),
    `Request ${item.turnRequestId} (${item.reason}) from ${author} in ${item.roomId}. ${answerTo}`,
    'Use this requestId with tools that ask for one.',
    `[message id: ${source.id}]`,
    ...(source.replyToMessageId ? [`Reply to message ${source.replyToMessageId}; read it with session tools if needed.`] : []),
    `${author}: ${body.trim() || '(shared attachments)'}`,
    ...(source.replyToExcerpt ? [`In reply to ${source.replyToAuthorName ?? 'a message'}: ${source.replyToExcerpt}`] : []),
    ...attachmentMarkerLines(source.attachments),
  ].join('\n');
}
