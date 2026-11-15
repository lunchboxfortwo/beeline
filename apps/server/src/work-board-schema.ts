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
CREATE INDEX IF NOT EXISTS work_items_room_idx ON work_items(room_id);
CREATE INDEX IF NOT EXISTS work_items_source_idx ON work_items(source_message_id);
CREATE INDEX IF NOT EXISTS work_items_assignee_idx ON work_items(assignee_id);
CREATE INDEX IF NOT EXISTS work_items_opener_idx ON work_items(opened_by);
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
