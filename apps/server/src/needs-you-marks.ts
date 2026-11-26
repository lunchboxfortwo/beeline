import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { IMPLEMENTER_BLOCKS_SCHEMA } from './implementer-blocks.js';
import { agentReportSql, askingMessageSql, needsYouAnsweredSql, questionForSql, questionRecipientSql, settledMarkReasonSql, supersedesSql, viewerMemberSql } from './needs-you.js';
import { humanReportCornerSql } from './corner-waiting-report.js';

/** Resolve an incoming request once, in the message's own transaction. */
function requestedSql(message = 'm'): string {
  return `${message}.deleted_at IS NULL AND ${message}.author_id<>recipient.id AND (
    (${askingMessageSql(message)} AND ${message}.card->>'reportToId'=recipient.id)
    OR (recipient.kind='human' AND ${questionRecipientSql(message, 'recipient.id')})
    OR (recipient.kind='human' AND ${message}.card_type='work-assignment' AND ${message}.card->>'assigneeId'=recipient.id)
  )`;
}

/** All send paths already commit messages through the same database boundary. */
export function needsYouMarksSchema(): string {
  return `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ask_closed_reason text;
${IMPLEMENTER_BLOCKS_SCHEMA}
CREATE OR REPLACE FUNCTION reply_block_root(reply_id text) RETURNS text LANGUAGE sql STABLE AS $root$
  WITH RECURSIVE chain AS (
    SELECT id,reply_to_message_id,block_corner_id,block_parent_id FROM messages WHERE id=reply_id
    UNION
    SELECT m.id,m.reply_to_message_id,m.block_corner_id,m.block_parent_id FROM messages m JOIN chain c ON m.id=c.reply_to_message_id
  ) SELECT id FROM chain WHERE block_corner_id IS NOT NULL OR block_parent_id IS NOT NULL LIMIT 1
$root$;
CREATE OR REPLACE FUNCTION block_reply_items(root_id text) RETURNS text[] LANGUAGE sql STABLE AS $items$
  WITH RECURSIVE chain AS (
    SELECT id FROM messages WHERE id=root_id
    UNION
    SELECT reply.id FROM messages reply JOIN chain parent ON reply.reply_to_message_id=parent.id
      WHERE reply.deleted_at IS NULL
  ) SELECT array_agg(id) FROM chain
$items$;
ALTER TABLE needs_you_marks ADD COLUMN IF NOT EXISTS cleared_reason text;
CREATE INDEX IF NOT EXISTS needs_you_marks_open_identity_idx ON needs_you_marks(identity_id) WHERE cleared_at IS NULL;
CREATE OR REPLACE FUNCTION refresh_needs_you_mark(asking_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM messages WHERE id=asking_id FOR UPDATE;
  UPDATE needs_you_marks mark SET cleared_at=now(),
    cleared_reason=COALESCE(${settledMarkReasonSql('m', 'recipient.id')},'removed')
  FROM messages m,identities recipient
  WHERE mark.message_id=asking_id AND mark.cleared_at IS NULL AND m.id=mark.message_id
    AND recipient.id=mark.identity_id
    AND (m.deleted_at IS NOT NULL
      OR ((${requestedSql()}) IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=m.id AND choice.mode='question'))
      OR (${settledMarkReasonSql('m', 'recipient.id')}) IS NOT NULL);
  INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at,cleared_reason)
    SELECT recipient.id,m.id,room.workspace_id,
      CASE WHEN (${settledMarkReasonSql('m', 'recipient.id')}) IS NOT NULL THEN now() END,
      ${settledMarkReasonSql('m', 'recipient.id')}
    FROM messages m JOIN rooms room ON room.id=m.room_id
    JOIN LATERAL (
      SELECT member.identity_id FROM room_access member WHERE member.room_id=room.id AND member.removed_at IS NULL
      UNION
      SELECT work.assignee_id FROM work_questions question JOIN work_items work ON work.id=question.message_id
        WHERE question.message_id=m.id
      UNION
      SELECT jsonb_array_elements_text(COALESCE(m.card->'mentionIds','[]'::jsonb)
        || jsonb_build_array(m.card->'requester'->>'pubkey'))
        WHERE EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=m.id AND choice.mode='question')
      UNION
      SELECT m.card->>'assigneeId' WHERE m.card_type='work-assignment'
    ) addressed ON true
    JOIN identities recipient ON recipient.id=addressed.identity_id
    WHERE m.id=asking_id
      AND (${questionRecipientSql('m', 'recipient.id')} OR ${viewerMemberSql('room.workspace_id', 'recipient.id')})
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
DECLARE reasked_block text;
BEGIN
  -- A new receipt that is not a message or an agent command (an approval-mode
  -- line, for example) asks no one: no mark exists for it yet, and only a
  -- message, an agent command or a question row can raise or clear one.
  -- Question rows refresh the mark from their own trigger.
  IF TG_OP='INSERT' AND NEW.presentation IS DISTINCT FROM 'message' AND NEW.card_type IS DISTINCT FROM 'agent-command'
    AND NEW.card_type IS DISTINCT FROM 'work-assignment'
    AND NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=NEW.id AND choice.mode='question') THEN
    RETURN NEW;
  END IF;
  IF (NEW.presentation='message' OR NEW.card_type='agent-command') AND NEW.system_event IS NULL AND NEW.deleted_at IS NULL THEN
    UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='answered'
    FROM messages m WHERE (mark.identity_id=NEW.author_id OR mark.message_id=NEW.reply_to_message_id)
      AND mark.cleared_at IS NULL
      AND m.id=mark.message_id AND ${needsYouAnsweredSql('m', 'mark.identity_id')};
  END IF;
  -- The same agent's newer report from the same thread replaces its older asks of that person.
  IF ${agentReportSql('NEW')} THEN
    UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='superseded'
    FROM messages m WHERE mark.identity_id=NEW.card->>'reportToId' AND mark.cleared_at IS NULL
      AND m.id=mark.message_id AND ${supersedesSql('NEW', 'm', 'mark.identity_id')};
  END IF;
  IF NEW.reply_to_message_id IS NOT NULL AND (NEW.presentation='message' OR NEW.card_type='agent-command')
    AND COALESCE(NEW.card->>'reportStatus','') NOT IN ('blocked','needs-decision') THEN
    UPDATE messages block SET block_reasked_at=NEW.created_at
      FROM corner_facts fact WHERE block.id=reply_block_root(NEW.reply_to_message_id)
      AND ((fact.corner_id=block.block_corner_id AND fact.implementer_agent_id=NEW.author_id)
        OR (block.block_corner_id IS NULL AND block.block_parent_id IS NOT NULL AND block.author_id=NEW.author_id))
      AND block.ask_closed_reason IS NULL AND NEW.created_at>COALESCE(block.block_reasked_at,block.created_at)
      RETURNING block.id INTO reasked_block;
    IF reasked_block IS NOT NULL THEN
      UPDATE needs_you_marks SET cleared_at=NULL,cleared_reason=NULL WHERE message_id=reasked_block;
    END IF;
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
CREATE OR REPLACE FUNCTION identify_implementer_block() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_block text;
BEGIN
  source_block := reply_block_root(NEW.reply_to_message_id);
  IF source_block IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM messages b LEFT JOIN corner_facts f ON f.corner_id=b.block_corner_id
      WHERE b.id=source_block AND COALESCE(NEW.card->'route'->'from'->>'place',NEW.card->>'sourceRoomId',NEW.room_id::text)
        =COALESCE(b.block_corner_id::text,b.card->>'sourceRoomId',b.room_id::text) AND (f.implementer_agent_id=NEW.author_id
        OR (b.block_corner_id IS NULL AND b.block_parent_id IS NOT NULL AND b.author_id=NEW.author_id))) THEN
      IF COALESCE(NEW.card->>'reportStatus','') NOT IN ('blocked','needs-decision') THEN
        RETURN NEW;
      END IF;
    ELSIF NEW.card->>'reportStatus' IN ('blocked','needs-decision') THEN
      IF EXISTS(WITH RECURSIVE sources AS (SELECT id,author_id,block_parent_id,COALESCE(block_corner_id::text,card->>'sourceRoomId',room_id::text) place FROM messages WHERE id=source_block
        UNION SELECT b.id,b.author_id,b.block_parent_id,COALESCE(b.block_corner_id::text,b.card->>'sourceRoomId',b.room_id::text) FROM messages b JOIN sources s ON b.id=s.block_parent_id)
        SELECT 1 FROM sources WHERE author_id=NEW.card->>'reportToId' AND place=NEW.room_id::text) THEN
        RAISE EXCEPTION 'A linked block cannot target its source implementer';
      END IF;
      NEW.block_parent_id := source_block;
    END IF;
  END IF;
  IF NEW.card->>'reportStatus' IN ('blocked','needs-decision') AND NEW.card->>'reportToId' IS NOT NULL AND NEW.block_corner_id IS NULL THEN
    SELECT room.id INTO NEW.block_corner_id FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
      WHERE room.id::text=COALESCE(NEW.card->'route'->'from'->>'place',NEW.card->>'sourceRoomId',NEW.room_id::text) AND room.parent_id IS NOT NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS identify_implementer_block ON messages;
CREATE TRIGGER identify_implementer_block BEFORE INSERT OR UPDATE OF card ON messages
  FOR EACH ROW EXECUTE FUNCTION identify_implementer_block();
DO $blocks$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM workflow_backfills WHERE name='implementer-blocks-v1') THEN
    INSERT INTO messages(id,room_id,author_id,text,presentation,card,created_at,ask_closed_reason)
      SELECT command.id,command.room_id,command.private_payload->>'authorId',command.private_payload->>'text','message',
        jsonb_build_object('sourceRoomId',command.private_payload->>'originCornerId','reportToId',command.agent_id,
          'reportStatus',command.private_payload->>'reportStatus'),command.created_at,
        CASE WHEN EXISTS(SELECT 1 FROM agent_commands newer WHERE newer.private_payload->>'originCornerId'=command.private_payload->>'originCornerId'
          AND newer.private_payload->>'kind'='report' AND newer.private_payload->>'authorId'=command.private_payload->>'authorId'
          AND (newer.created_at,newer.id)>(command.created_at,command.id)) THEN 'superseded' END
      FROM agent_commands command JOIN rooms room ON room.id::text=command.private_payload->>'originCornerId'
      WHERE command.private_payload->>'kind'='report' AND command.private_payload->>'reportStatus' IN ('blocked','needs-decision')
        AND command.private_payload->>'authorId' NOT IN ('${SYSTEM_IDENTITY_ID}','${SCHEDULE_SCHEDULER_ID}')
        AND command.private_payload->>'automatic' IS DISTINCT FROM 'true' AND room.archived_at IS NULL
      ON CONFLICT(id) DO NOTHING;
    UPDATE messages m SET block_corner_id=room.id FROM rooms room,corner_facts fact
    WHERE room.id=fact.corner_id AND room.archived_at IS NULL
      AND m.author_id IN (fact.implementer_agent_id,fact.owner_agent_id) AND ${humanReportCornerSql('m')}=room.id::text
      AND m.ask_closed_reason IS NULL AND m.deleted_at IS NULL
      AND m.card->>'reportStatus' IN ('blocked','needs-decision')
      AND m.card->>'reportToId' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM messages newer WHERE newer.author_id=m.author_id
        AND ${humanReportCornerSql('newer')}=room.id::text AND ${agentReportSql('newer')}
        AND (newer.created_at,newer.id)>(m.created_at,m.id));
    INSERT INTO workflow_backfills(name) VALUES('implementer-blocks-v1');
  END IF;
END $blocks$;
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
${retirePersonTagsOnceSql()}
`;
}

/** Clear open marks left by the retired human-to-human mention branch once on deploy. */
function retirePersonTagsOnceSql(): string {
  return `DO $needs_you_retire_person_tags$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='needs-you-retire-person-tags-v1') THEN
      UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='removed'
      FROM messages m,identities recipient
      WHERE mark.message_id=m.id AND recipient.id=mark.identity_id AND mark.cleared_at IS NULL
        AND m.presentation='message'
        AND (${requestedSql()}) IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=m.id AND choice.mode='question');
      INSERT INTO workflow_backfills(name) VALUES('needs-you-retire-person-tags-v1') ON CONFLICT DO NOTHING;
    END IF;
  END $needs_you_retire_person_tags$;`;
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
