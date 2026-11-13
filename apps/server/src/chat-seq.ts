import type { SqlDatabase } from './database.js';

/**
 * Every message in a chat (a Room together with its threads) gets a number,
 * `chat_seq`, in the order it was written. `¶author-N` names a message by
 * that number (`message-links.ts`), so it never exposes an internal id.
 *
 * Messages are written by many separate INSERT statements, so a trigger is
 * the one place that numbers all of them. The counter row serializes numbers
 * for one chat only. A counter that does not exist yet starts after every
 * message the chat already holds, so history numbered by
 * `backfillChatSeq` (1..k, oldest first) and new rows never collide.
 */
export const CHAT_SEQ_SCHEMA = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_seq integer;
CREATE TABLE IF NOT EXISTS chat_message_counters (
  root_room_id uuid PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  last_seq integer NOT NULL
);
CREATE OR REPLACE FUNCTION messages_assign_chat_seq() RETURNS trigger
LANGUAGE plpgsql AS $chat_seq$
DECLARE root uuid;
BEGIN
  IF NEW.chat_seq IS NOT NULL OR NEW.presentation<>'message' THEN RETURN NEW; END IF;
  SELECT COALESCE(parent_id,id) INTO root FROM rooms WHERE id=NEW.room_id;
  IF root IS NULL THEN RETURN NEW; END IF;
  UPDATE chat_message_counters SET last_seq=last_seq+1 WHERE root_room_id=root
    RETURNING last_seq INTO NEW.chat_seq;
  IF NOT FOUND THEN
    INSERT INTO chat_message_counters AS counter(root_room_id,last_seq)
      SELECT root,GREATEST(count(*),COALESCE(max(m.chat_seq),0))+1
      FROM messages m JOIN rooms r ON r.id=m.room_id
      WHERE (r.id=root OR r.parent_id=root) AND m.presentation='message'
    ON CONFLICT (root_room_id) DO UPDATE SET last_seq=counter.last_seq+1
    RETURNING last_seq INTO NEW.chat_seq;
  END IF;
  RETURN NEW;
END
$chat_seq$;
DROP TRIGGER IF EXISTS messages_chat_seq_trg ON messages;
CREATE TRIGGER messages_chat_seq_trg BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_assign_chat_seq();
`;

/** Built concurrently so the migration never blocks writes to messages. */
export const CHAT_SEQ_INDEX = `CREATE INDEX CONCURRENTLY messages_author_chat_seq_idx
  ON messages(author_id,chat_seq) WHERE chat_seq IS NOT NULL`;

/**
 * Number the messages written before the trigger existed, one chat at a time,
 * oldest first. Rows the trigger already numbered are left alone; they come
 * after every older row. Safe to rerun: a chat with nothing unnumbered is a
 * no-op.
 */
export async function backfillChatSeq(database: SqlDatabase, batchSize = 200): Promise<number> {
  let numbered = 0;
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const roots = await database.query<{ id: string }>(
      `SELECT id::text id FROM rooms WHERE parent_id IS NULL AND id>$1::uuid ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    for (const root of roots.rows) {
      const updated = await database.query(
        `UPDATE messages SET chat_seq=numbered.seq
         FROM (
           SELECT m.id,row_number() OVER (ORDER BY m.created_at,m.id)::integer seq
           FROM messages m JOIN rooms r ON r.id=m.room_id
           WHERE (r.id=$1::uuid OR r.parent_id=$1::uuid)
             AND m.presentation='message' AND m.chat_seq IS NULL
         ) numbered
         WHERE messages.id=numbered.id AND messages.chat_seq IS NULL`,
        [root.id],
      );
      numbered += updated.rowCount ?? 0;
    }
    if (roots.rows.length < batchSize) return numbered;
    cursor = roots.rows[roots.rows.length - 1]!.id;
  }
}
