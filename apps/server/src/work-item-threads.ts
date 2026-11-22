import { CommandRefusalError } from './command-refusal.js';
import type { WorkState } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { updateWorkItem } from './work-board.js';

/** At most this many chat tasks per opened thread. */
export const MAX_THREAD_WORK_ITEMS = 8;

/** The web address of a thread, the link a task shows for the thread that builds it. */
export function threadWebUrl(threadId: string, workspaceId: string): string {
  return `https://web.usebeeline.app/beeline/chat/${encodeURIComponent(threadId)}?communityId=${encodeURIComponent(workspaceId)}`;
}

/**
 * Link chat tasks to the thread opened to build them, inside the opening transaction.
 * Each id must name a task (not a thread or an ask) in the thread's parent chat. Each
 * linked task moves to In progress and gets a link to the thread.
 */
export async function linkThreadWorkItems(db: SqlDatabase, input: {
  threadId: string; chatId: string; workspaceId: string; threadName: string;
  itemIds: readonly string[]; actorId: string;
}): Promise<void> {
  const ids = [...new Set(input.itemIds.map(id => String(id).trim()).filter(Boolean))];
  if (!ids.length) return;
  if (ids.length > MAX_THREAD_WORK_ITEMS)
    throw new CommandRefusalError(`a thread builds at most ${MAX_THREAD_WORK_ITEMS} work items`, 400);
  const found = new Set((await db.query<{ id: string }>(
    `SELECT w.id FROM work_items w
     WHERE w.id=ANY($1::text[]) AND w.room_id=$2 AND w.source_message_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM rooms thread WHERE thread.id::text=w.id)
     FOR UPDATE OF w`,
    [ids, input.chatId],
  )).rows.map(row => row.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length)
    throw new CommandRefusalError(`workItems must be task ids in the thread's parent chat: ${missing.join(', ')}`, 400);
  await db.query(
    `INSERT INTO work_item_threads(work_item_id,thread_id) SELECT id,$2 FROM unnest($1::text[]) id
     ON CONFLICT DO NOTHING`, [ids, input.threadId]);
  const link = { kind: 'link' as const, name: `Thread: ${input.threadName}`,
    url: threadWebUrl(input.threadId, input.workspaceId) };
  for (const id of ids)
    await updateWorkItem(db, { roomId: input.chatId, id, state: 'in-progress', attachments: [link] }, input.actorId);
}

/**
 * A linked thread closed. Its tasks stay In progress while another linked thread is
 * open; otherwise they move to Done when any linked thread landed, else to Backlog.
 */
export async function settleThreadWorkItems(db: SqlDatabase, threadId: string, landed: boolean): Promise<void> {
  const settled = (await db.query<{ id: string; room_id: string; state: WorkState; access_id: string | null; actor_id: string | null }>(
    `WITH settled AS (
       UPDATE work_item_threads SET landed=$2 WHERE thread_id=$1 RETURNING work_item_id
     ), implementer AS (SELECT implementer_agent_id id FROM corner_facts WHERE corner_id=$1)
     SELECT w.id,w.room_id,
       CASE WHEN $2 OR EXISTS(SELECT 1 FROM work_item_threads other
         WHERE other.work_item_id=w.id AND other.thread_id<>$1 AND other.landed) THEN 'done' ELSE 'backlog' END state,
       access.identity_id access_id,COALESCE((SELECT id FROM implementer),access.identity_id) actor_id
     FROM work_items w
     -- updateWorkItem writes as a current chat member: the implementer, else the opener, else anyone.
     LEFT JOIN LATERAL (SELECT a.identity_id FROM room_access a WHERE a.room_id=w.room_id AND a.removed_at IS NULL
       ORDER BY a.identity_id IS NOT DISTINCT FROM (SELECT id FROM implementer) DESC,a.identity_id=w.opened_by DESC,a.identity_id
       LIMIT 1) access ON true
     WHERE w.id IN (SELECT work_item_id FROM settled)
       AND NOT EXISTS(SELECT 1 FROM work_item_threads other JOIN rooms thread ON thread.id=other.thread_id
         WHERE other.work_item_id=w.id AND other.thread_id<>$1 AND thread.archived_at IS NULL)`,
    [threadId, landed])).rows;
  for (const item of settled)
    if (item.access_id && item.actor_id)
      await updateWorkItem(db, { roomId: item.room_id, id: item.id, state: item.state }, item.actor_id, item.access_id);
}
