import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';

/** At most this many chat tasks per opened thread. */
export const MAX_THREAD_WORK_ITEMS = 8;

/** The web address of a thread, the link a task shows for the thread that builds it. */
export function threadWebUrl(threadId: string, workspaceId: string): string {
  return `https://web.usebeeline.app/beeline/chat/${encodeURIComponent(threadId)}?communityId=${encodeURIComponent(workspaceId)}`;
}

async function asActor<T>(db: SqlDatabase, actorId: string | null, write: () => Promise<T>): Promise<T> {
  const previous = (await db.query<{ actor: string | null }>(
    "SELECT current_setting('beeline.work_actor',true) actor")).rows[0]?.actor ?? '';
  if (actorId) await db.query("SELECT set_config('beeline.work_actor',$1,true)", [actorId]);
  try {
    return await write();
  } finally {
    if (actorId) await db.query("SELECT set_config('beeline.work_actor',$1,true)", [previous]);
  }
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
  await asActor(db, input.actorId, async () => {
    await db.query(
      `INSERT INTO work_item_threads(work_item_id,thread_id) SELECT id,$2 FROM unnest($1::text[]) id
       ON CONFLICT DO NOTHING`, [ids, input.threadId]);
    await db.query(
      `UPDATE work_items SET state='in-progress',completed_at=NULL,updated_at=now()
       WHERE id=ANY($1::text[]) AND state IS DISTINCT FROM 'in-progress'`, [ids]);
    await db.query(
      `INSERT INTO work_item_attachments(work_item_id,kind,name,url,added_by)
       SELECT id,'link',$2,$3,$4 FROM unnest($1::text[]) id`,
      [ids, `Thread: ${input.threadName}`, threadWebUrl(input.threadId, input.workspaceId), input.actorId]);
  });
}

/**
 * A linked thread closed. Its tasks stay In progress while another linked thread is
 * open; otherwise they move to Done when any linked thread landed, else to Backlog.
 */
export async function settleThreadWorkItems(db: SqlDatabase, threadId: string, landed: boolean): Promise<void> {
  const implementer = (await db.query<{ id: string | null }>(
    'SELECT implementer_agent_id id FROM corner_facts WHERE corner_id=$1', [threadId])).rows[0]?.id ?? null;
  await asActor(db, implementer, async () => {
    // The CTE's write is not visible to the outer statement, so this thread's
    // own outcome is read from $2 and only other links are read from the table.
    await db.query(
      `WITH settled AS (
         UPDATE work_item_threads SET landed=$2 WHERE thread_id=$1 RETURNING work_item_id
       ), next AS (
         SELECT w.id,CASE WHEN $2 OR EXISTS(SELECT 1 FROM work_item_threads other
           WHERE other.work_item_id=w.id AND other.thread_id<>$1 AND other.landed) THEN 'done' ELSE 'backlog' END state
         FROM work_items w WHERE w.id IN (SELECT work_item_id FROM settled)
           AND NOT EXISTS(SELECT 1 FROM work_item_threads other JOIN rooms thread ON thread.id=other.thread_id
             WHERE other.work_item_id=w.id AND other.thread_id<>$1 AND thread.archived_at IS NULL)
       )
       UPDATE work_items w SET state=next.state,updated_at=now(),
         completed_at=CASE WHEN next.state='done' THEN COALESCE(w.completed_at,now()) END
       FROM next WHERE w.id=next.id AND w.state IS DISTINCT FROM next.state`,
      [threadId, landed]);
  });
}
