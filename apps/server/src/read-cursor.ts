import { hiddenWakeCardSql } from './room-choice.js';

/**
 * Highest tally the cursor reports. Past it the exact number is not something
 * any surface would say out loud, and counting further makes the scan behind a
 * long-abandoned mark grow with the whole backlog.
 */
export const UNREAD_COUNT_CAP = 99;

/** Shared transcript visibility, including legacy corner completion cards. */
export function visibleMessageSql(alias: string): string {
  // Keep the source-free Room record only when no other conversation has the
  // call site. Legacy servers may already have settled either opening card.
  // A schedule's run is kept in the routine's history, not the chat.
  return `${hiddenWakeCardSql(alias)}
      AND ${alias}.system_transcript->>'visibility' IS DISTINCT FROM 'hidden'
      AND NOT (${alias}.card_type IS NOT DISTINCT FROM 'github-corner-note'
        AND COALESCE(${alias}.system_event->>'verb','') IN ('opened a pull request','merged')
        AND EXISTS (SELECT 1 FROM rooms pr_thread
          WHERE pr_thread.id=${alias}.room_id AND pr_thread.parent_id IS NOT NULL))
      AND ${alias}.system_event->>'kind' IS DISTINCT FROM 'schedule-ran'
      AND NOT (${alias}.card_type IS NOT DISTINCT FROM 'daemon-fact'
        AND COALESCE(${alias}.card->>'type','') IN ('corner-open','corner-complete')
        AND ${alias}.card->>'sourceMessageId' IS NULL
        AND EXISTS (SELECT 1 FROM rooms opening_corner
          WHERE opening_corner.id::text=${alias}.card->>'cornerId'
            AND opening_corner.parent_id=${alias}.room_id)
        AND EXISTS (SELECT 1 FROM messages callsite
          WHERE callsite.room_id<>${alias}.room_id
            AND callsite.card_type='daemon-fact'
            AND callsite.card->>'cornerId'=${alias}.card->>'cornerId'
            AND callsite.card->>'type' IN ('corner-open','corner-complete')
            AND callsite.card->>'sourceMessageId' IS NOT NULL))
      AND NOT (${alias}.card_type IS NOT DISTINCT FROM 'daemon-fact'
        AND ${alias}.card->>'type' IS NOT DISTINCT FROM 'corner-complete'
        AND COALESCE(${alias}.system_event->>'kind','')<>'corner-opened'
        AND ${alias}.card->>'sourceMessageId' IS NULL
        AND EXISTS (SELECT 1 FROM rooms completed_corner
          WHERE completed_corner.id::text=${alias}.card->>'cornerId'
            AND completed_corner.parent_id=${alias}.room_id))`;
}

/** A durable message that can represent activity in the Room list. */
export function visibleChatMessageSql(alias: string): string {
  return `${alias}.presentation IN ('message','system','card')
      AND ${alias}.deleted_at IS NULL
      AND ${visibleMessageSql(alias)}`;
}

/** The stored report metadata identifies a block addressed to an agent. */
export function agentBlockSql(alias: string): string {
  return `(${alias}.card->>'reportStatus' IS NOT DISTINCT FROM 'blocked'
      AND ${alias}.card->'recipient'->>'kind' IS NOT DISTINCT FROM 'agent')`;
}

/**
 * WHAT COUNTS AS UNREAD. One definition, and the only one.
 *
 * Three used to disagree: the read cursor took `presentation<>'activity'`, the
 * deck's boolean took the `('message','system','card')` allowlist, and the
 * phone's own queue counted every folded id with no presentation rule at all.
 * A Room could therefore report a first-unread row that the deck refused to
 * call unread. The closed preview allowlist excludes deleted and hidden rows,
 * and `IS DISTINCT FROM` wins over `<>` because a row with no author is
 * somebody else's, not nobody's.
 *
 * The phone's half of this same rule lives in
 * `apps/mobile/sources/buzz/room-new-message-boundary.ts` (`countsAsUnread`);
 * the two are pinned together by `read-cursor.test.ts`.
 *
 * `$2` is the viewer.
 */
export function unreadMessageSql(alias: string, viewer = '$2'): string {
  const column = (name: string) => `${alias}.${name}`;
  // An agent's order or report record is reference, not news: it never counts.
  return `${visibleChatMessageSql(alias)}
      AND ${column('card_type')} IS DISTINCT FROM 'agent-command'
      AND NOT ${agentBlockSql(alias)}
      AND ${column('author_id')} IS DISTINCT FROM ${viewer}`;
}

/**
 * One viewer's read boundary, correlated with the authorized Room (`room.id`)
 * and the viewer (`$2`): where they are, what the first thing they have not
 * read is, and how much of it there is. Both Room read paths project it from
 * here, so they can never disagree about where a reader is.
 *
 * `unreadCount` rides along because it answers the same question from the same
 * mark in the same pass — a surface that wants the number never costs a second
 * trip to get it.
 */
export function viewerReadCursorSql(): string {
  // Built on call: the corner idle reads import this module inside a cycle.
  return `(WITH mark AS (
    SELECT message_id,message_created_at FROM room_read_marks
    WHERE room_id=room.id AND identity_id=$2
  ), unread AS MATERIALIZED (
    SELECT message.id,message.created_at FROM messages message
    WHERE message.room_id=room.id
      AND ${unreadMessageSql('message')}
      AND (message.created_at,message.id)>(
        COALESCE((SELECT message_created_at FROM mark),'-infinity'::timestamptz),
        COALESCE((SELECT message_id FROM mark),'')
      )
    ORDER BY message.created_at,message.id LIMIT ${UNREAD_COUNT_CAP}
  ) SELECT jsonb_build_object(
    'messageId',(SELECT message_id FROM mark),
    'firstUnreadMessageId',(array_agg(id ORDER BY created_at,id))[1],
    'unreadCount',count(*)::int
  ) FROM unread)`;
}
