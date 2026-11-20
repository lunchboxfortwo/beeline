import { agentReportSql, askingMessageSql, needsYouAnsweredSql, questionForSql, questionRecipientSql, settledMarkReasonSql, supersedesSql, viewerMemberSql } from './needs-you.js';
import { humanReportCornerSql } from './corner-waiting-report.js';
import { tagsKnownIdentitySql } from './message-mentions.js';

/** Resolve an incoming request once, in the message's own transaction. */
function requestedSql(message = 'm'): string {
  return `${message}.deleted_at IS NULL AND ${message}.author_id<>recipient.id AND (
    (${askingMessageSql(message)} AND ${message}.card->>'reportToId'=recipient.id)
    OR (${message}.presentation='message' AND ${message}.system_event IS NULL AND recipient.kind='human'
      AND EXISTS (SELECT 1 FROM identities sender WHERE sender.id=${message}.author_id AND sender.kind='human')
      AND ${tagsKnownIdentitySql(message, 'recipient.id', 'recipient.handle', 'recipient.kind', false)})
    OR (recipient.kind='human' AND ${questionRecipientSql(message, 'recipient.id')})
  )`;
}

/** All send paths already commit messages through the same database boundary. */
export function needsYouMarksSchema(): string {
  return `
ALTER TABLE needs_you_marks ADD COLUMN IF NOT EXISTS cleared_reason text;
CREATE INDEX IF NOT EXISTS needs_you_marks_open_identity_idx ON needs_you_marks(identity_id) WHERE cleared_at IS NULL;
CREATE OR REPLACE FUNCTION refresh_needs_you_mark(asking_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE needs_you_marks mark SET cleared_at=now(),
    cleared_reason=COALESCE(${settledMarkReasonSql('m', 'recipient.id')},'removed')
  FROM messages m,identities recipient
  WHERE mark.message_id=asking_id AND mark.cleared_at IS NULL AND m.id=mark.message_id
    AND recipient.id=mark.identity_id
    AND ((${requestedSql()}) IS NOT TRUE OR (${settledMarkReasonSql('m', 'recipient.id')}) IS NOT NULL);
  INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at,cleared_reason)
    SELECT recipient.id,m.id,room.workspace_id,
      CASE WHEN (${settledMarkReasonSql('m', 'recipient.id')}) IS NOT NULL THEN now() END,
      ${settledMarkReasonSql('m', 'recipient.id')}
    FROM messages m JOIN rooms room ON room.id=m.room_id
    JOIN room_access member ON member.room_id=room.id AND member.removed_at IS NULL
    JOIN identities recipient ON recipient.id=member.identity_id
    WHERE m.id=asking_id
      AND ${viewerMemberSql('room.workspace_id', 'recipient.id')}
      AND ${requestedSql()}
    ON CONFLICT(identity_id,message_id) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION question_needs_you_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_needs_you_mark(CASE WHEN TG_TABLE_NAME='work_items' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'message_id' END);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS question_needs_you_mark ON work_questions;
CREATE TRIGGER question_needs_you_mark AFTER INSERT OR UPDATE ON work_questions
  FOR EACH ROW EXECUTE FUNCTION question_needs_you_mark();
DROP TRIGGER IF EXISTS question_needs_you_mark ON work_items;
CREATE TRIGGER question_needs_you_mark AFTER INSERT OR UPDATE OF assignee_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION question_needs_you_mark();
DROP TRIGGER IF EXISTS question_needs_you_mark ON room_choices;
CREATE TRIGGER question_needs_you_mark AFTER INSERT OR UPDATE OF status ON room_choices
  FOR EACH ROW EXECUTE FUNCTION question_needs_you_mark();
CREATE OR REPLACE FUNCTION maintain_needs_you_marks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Replies settle only the author's open items, using the former read-time rule.
  IF NEW.presentation='message' AND NEW.system_event IS NULL AND NEW.deleted_at IS NULL THEN
    UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='answered'
    FROM messages m WHERE mark.identity_id=NEW.author_id AND mark.cleared_at IS NULL
      AND m.id=mark.message_id AND ${needsYouAnsweredSql('m', 'mark.identity_id')};
  END IF;
  -- The same agent's newer report from the same thread replaces its older asks of that person.
  IF ${agentReportSql('NEW')} THEN
    UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='superseded'
    FROM messages m WHERE mark.identity_id=NEW.card->>'reportToId' AND mark.cleared_at IS NULL
      AND m.id=mark.message_id AND ${supersedesSql('NEW', 'm', 'mark.identity_id')};
  END IF;
  PERFORM refresh_needs_you_mark(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS message_needs_you_marks ON messages;
CREATE TRIGGER message_needs_you_marks AFTER INSERT OR UPDATE OF text,card,presentation,system_event,deleted_at,reply_to_message_id,request_id ON messages
  FOR EACH ROW EXECUTE FUNCTION maintain_needs_you_marks();
-- Closing a thread settles the open asks it raised, wherever they were posted.
CREATE OR REPLACE FUNCTION close_source_needs_you_marks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='source-closed'
  FROM messages m WHERE mark.workspace_id=NEW.workspace_id AND mark.cleared_at IS NULL AND m.id=mark.message_id
    AND (m.room_id=NEW.id OR ${humanReportCornerSql('m')}=NEW.id::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS room_close_needs_you_marks ON rooms;
CREATE TRIGGER room_close_needs_you_marks AFTER UPDATE OF archived_at ON rooms
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION close_source_needs_you_marks();
-- The retired paint clock stays for rollback overlap; no write starts it.
ALTER TABLE needs_you_marks ALTER COLUMN first_seen_at DROP NOT NULL;
ALTER TABLE needs_you_marks ALTER COLUMN first_seen_at DROP DEFAULT;
-- The message trigger lock keeps new writes outside this one-time legacy snapshot.
${backfillOnceSql()}
${retireClockOnceSql()}
DO $question_marks$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='needs-you-question-marks-v1') THEN
    PERFORM refresh_needs_you_mark(message_id) FROM (
      SELECT message_id FROM work_questions UNION SELECT message_id FROM room_choices WHERE mode='question'
    ) questions;
    INSERT INTO workflow_backfills(name) VALUES('needs-you-question-marks-v1') ON CONFLICT DO NOTHING;
  END IF;
END $question_marks$;
`;
}

/** Records the retired clock already hid stay cleared once nothing expires. */
function retireClockOnceSql(): string {
  return `DO $needs_you_retired_clock$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='needs-you-retired-clock-v1') THEN
      UPDATE needs_you_marks SET cleared_at=first_seen_at+interval '24 hours',cleared_reason='expired'
      WHERE cleared_at IS NULL AND first_seen_at+interval '24 hours'<=now();
      INSERT INTO workflow_backfills(name) VALUES('needs-you-retired-clock-v1') ON CONFLICT DO NOTHING;
    END IF;
  END $needs_you_retired_clock$;`;
}

/** Current legacy report cells only: historical person tags never enter the new index. */
const NEEDS_YOU_MARKS_BACKFILL_ROWS = `
SELECT recipient.id identity_id,m.id message_id,room.workspace_id
FROM messages m JOIN rooms room ON room.id=m.room_id
JOIN identities recipient ON recipient.id=m.card->>'reportToId'
JOIN room_access member ON member.room_id=room.id AND member.identity_id=recipient.id AND member.removed_at IS NULL
LEFT JOIN needs_you_marks mark ON mark.identity_id=recipient.id AND mark.message_id=m.id
WHERE room.archived_at IS NULL AND ${viewerMemberSql('room.workspace_id', 'recipient.id')}
  AND ${questionForSql('recipient.id')}`;

/** Run while installing the message trigger, before any new person-tag marks exist. */
function backfillOnceSql(): string {
  return `DO $needs_you_backfill$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='needs-you-open-items-v1') THEN
      UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason=COALESCE(${settledMarkReasonSql('m', 'mark.identity_id')},'removed') FROM messages m
      WHERE mark.message_id=m.id AND mark.cleared_at IS NULL AND m.presentation='message'
        AND (${questionForSql('mark.identity_id')}) IS NOT TRUE;
      INSERT INTO needs_you_marks(identity_id,message_id,workspace_id)
        ${NEEDS_YOU_MARKS_BACKFILL_ROWS} ON CONFLICT(identity_id,message_id) DO NOTHING;
      INSERT INTO workflow_backfills(name) VALUES('needs-you-open-items-v1') ON CONFLICT DO NOTHING;
    END IF;
  END $needs_you_backfill$;`;
}
