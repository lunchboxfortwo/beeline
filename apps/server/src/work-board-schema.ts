import { askSql } from './needs-you.js';
import { workItemNotificationSchema } from './postgres-live.js';
export const WORK_BOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
  id text PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('needs-you','in-progress','in-review','backlog','done')),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent','high','medium','low','none')),
  title text,
  assignee_id text REFERENCES identities(id) ON DELETE SET NULL,
  opened_by text NOT NULL REFERENCES identities(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- priority is retired and kept only for rollout and rollback overlap.
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS objective text;
CREATE INDEX IF NOT EXISTS work_items_room_idx ON work_items(room_id);
CREATE INDEX IF NOT EXISTS work_items_source_idx ON work_items(source_message_id);
CREATE INDEX IF NOT EXISTS work_items_assignee_idx ON work_items(assignee_id);
CREATE INDEX IF NOT EXISTS work_items_opener_idx ON work_items(opened_by);
CREATE TABLE IF NOT EXISTS work_item_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id text NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file','link')),
  name text NOT NULL,
  url text,
  object_id uuid REFERENCES objects(id) ON DELETE CASCADE,
  added_by text NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind='file' AND object_id IS NOT NULL AND url IS NULL)
    OR (kind='link' AND url IS NOT NULL AND object_id IS NULL))
);
CREATE INDEX IF NOT EXISTS work_item_attachments_item_idx ON work_item_attachments(work_item_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS work_item_attachments_object_idx ON work_item_attachments(object_id);
CREATE INDEX IF NOT EXISTS work_item_attachments_author_idx ON work_item_attachments(added_by);
CREATE TABLE IF NOT EXISTS work_item_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id text NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES identities(id),
  kind text NOT NULL CHECK (kind IN ('note','event')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS work_item_entries_item_idx ON work_item_entries(work_item_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS work_item_entries_author_idx ON work_item_entries(author_id);
-- All server write paths, including answered asks, record actual transitions atomically.
CREATE OR REPLACE FUNCTION beeline_work_item_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := COALESCE(NULLIF(current_setting('beeline.work_actor',true),''),NEW.opened_by);
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO work_item_entries(work_item_id,author_id,kind,text)
      VALUES(NEW.id,actor,'event','created this item in ' || CASE NEW.state
        WHEN 'backlog' THEN 'Backlog' WHEN 'done' THEN 'Done' WHEN 'needs-you' THEN 'Needs you'
        WHEN 'in-review' THEN 'In review' ELSE 'In progress' END);
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO work_item_entries(work_item_id,author_id,kind,text)
      VALUES(NEW.id,actor,'event','moved this to ' || CASE NEW.state
        WHEN 'backlog' THEN 'Backlog' WHEN 'done' THEN 'Done' WHEN 'needs-you' THEN 'Needs you'
        WHEN 'in-review' THEN 'In review' ELSE 'In progress' END);
  END IF;
  IF (TG_OP='INSERT' AND NEW.assignee_id IS NOT NULL)
    OR (TG_OP='UPDATE' AND NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    INSERT INTO work_item_entries(work_item_id,author_id,kind,text)
      VALUES(NEW.id,actor,'event',CASE WHEN NEW.assignee_id IS NULL THEN 'unassigned this item'
        ELSE 'assigned this to ' || (SELECT name FROM identities WHERE id=NEW.assignee_id) END);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS work_item_entry ON work_items;
CREATE TRIGGER work_item_entry AFTER INSERT OR UPDATE OF state,assignee_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION beeline_work_item_entry();
-- Detail commits reuse the work item's existing cross-machine invalidation.
CREATE OR REPLACE FUNCTION beeline_work_detail_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work_items SET updated_at=clock_timestamp() WHERE id=NEW.work_item_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS work_attachment_changed ON work_item_attachments;
CREATE TRIGGER work_attachment_changed AFTER INSERT ON work_item_attachments
  FOR EACH ROW EXECUTE FUNCTION beeline_work_detail_changed();
DROP TRIGGER IF EXISTS work_note_changed ON work_item_entries;
CREATE TRIGGER work_note_changed AFTER INSERT ON work_item_entries
  FOR EACH ROW WHEN (NEW.kind='note') EXECUTE FUNCTION beeline_work_detail_changed();
CREATE TABLE IF NOT EXISTS work_questions (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  about jsonb NOT NULL,
  question text NOT NULL,
  recommended_option_id text
);
CREATE INDEX IF NOT EXISTS work_questions_room_idx ON work_questions(room_id);
${workItemNotificationSchema()}
DROP TRIGGER IF EXISTS work_item_changed ON work_items;
CREATE TRIGGER work_item_changed AFTER INSERT OR UPDATE ON work_items
FOR EACH ROW EXECUTE FUNCTION beeline_work_item_changed();
CREATE OR REPLACE FUNCTION beeline_work_reply_answered() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asking_agent text;
BEGIN
  IF NEW.reply_to_message_id IS NULL OR NEW.deleted_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM identities author WHERE author.id=NEW.author_id AND author.kind='human')
    THEN RETURN NEW; END IF;
  SELECT actor.id INTO asking_agent FROM messages asking
    JOIN identities actor ON actor.id=COALESCE(asking.card->'agent'->>'pubkey',asking.author_id) AND actor.kind='agent'
    WHERE asking.id=NEW.reply_to_message_id AND asking.room_id=NEW.room_id
      AND (EXISTS(SELECT 1 FROM work_questions q WHERE q.message_id=asking.id) OR ${askSql('asking.text')})
      AND NOT EXISTS(SELECT 1 FROM messages answered JOIN identities human ON human.id=answered.author_id AND human.kind='human'
        WHERE answered.reply_to_message_id=asking.id AND answered.id<>NEW.id AND answered.deleted_at IS NULL);
  IF asking_agent IS NOT NULL THEN
    INSERT INTO work_items(id,room_id,source_message_id,state,assignee_id,opened_by)
      SELECT NEW.reply_to_message_id,room.id,NEW.reply_to_message_id,'in-progress',asking_agent,asking_agent FROM rooms room WHERE room.id=NEW.room_id
      ON CONFLICT(id) DO UPDATE SET state='in-progress',assignee_id=asking_agent,updated_at=now(),completed_at=NULL
        WHERE work_items.state<>'done';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS work_reply_answered ON messages;
CREATE TRIGGER work_reply_answered AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION beeline_work_reply_answered();
`;
