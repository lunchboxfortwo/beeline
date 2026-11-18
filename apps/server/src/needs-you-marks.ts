import { askingMessageSql, NEEDS_YOU_EXPIRY_HOURS, needsYouAnsweredSql, questionForSql, viewerMemberSql } from './needs-you.js';
import { tagsKnownIdentitySql } from './message-mentions.js';

/** Resolve an incoming request once, in the message's own transaction. */
function requestedSql(message = 'm'): string {
  return `${message}.presentation='message' AND ${message}.deleted_at IS NULL AND ${message}.author_id<>recipient.id AND (
    (${askingMessageSql(message)} AND ${message}.card->>'reportToId'=recipient.id)
    OR (${message}.system_event IS NULL AND recipient.kind='human'
      AND EXISTS (SELECT 1 FROM identities sender WHERE sender.id=${message}.author_id AND sender.kind='human')
      AND ${tagsKnownIdentitySql(message, 'recipient.id', 'recipient.handle', 'recipient.kind', false)})
  )`;
}

/** All send paths already commit messages through the same database boundary. */
export function needsYouMarksSchema(): string {
  return `
CREATE INDEX IF NOT EXISTS needs_you_marks_open_identity_idx ON needs_you_marks(identity_id) WHERE cleared_at IS NULL;
CREATE OR REPLACE FUNCTION maintain_needs_you_marks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Replies settle only the author's open items, using the former read-time rule.
  IF NEW.presentation='message' AND NEW.system_event IS NULL AND NEW.deleted_at IS NULL THEN
    UPDATE needs_you_marks mark SET cleared_at=now()
    FROM messages m WHERE mark.identity_id=NEW.author_id AND mark.cleared_at IS NULL
      AND m.id=mark.message_id AND ${needsYouAnsweredSql('m', 'mark.identity_id')};
  END IF;
  -- Removing or retargeting the requesting message settles its existing records.
  UPDATE needs_you_marks mark SET cleared_at=now()
  FROM messages m,identities recipient
  WHERE mark.message_id=NEW.id AND mark.cleared_at IS NULL AND m.id=mark.message_id
    AND recipient.id=mark.identity_id
    AND ((${requestedSql()}) IS NOT TRUE OR ${needsYouAnsweredSql('m', 'recipient.id')});
  -- The trigger already owns this row; rejoining messages can scan Room history per write.
  INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at)
    SELECT recipient.id,NEW.id,room.workspace_id,NULL
    FROM rooms room
    JOIN room_access member ON member.room_id=room.id AND member.removed_at IS NULL
    JOIN identities recipient ON recipient.id=member.identity_id
    WHERE room.id=NEW.room_id AND room.archived_at IS NULL
      AND ${viewerMemberSql('room.workspace_id', 'recipient.id')}
      AND ${requestedSql('NEW')} AND NOT (${needsYouAnsweredSql('NEW', 'recipient.id')})
    ON CONFLICT(identity_id,message_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS message_needs_you_marks ON messages;
CREATE TRIGGER message_needs_you_marks AFTER INSERT OR UPDATE OF text,card,presentation,system_event,deleted_at,reply_to_message_id,request_id ON messages
  FOR EACH ROW EXECUTE FUNCTION maintain_needs_you_marks();
-- The message trigger lock keeps new writes outside this one-time legacy snapshot.
ALTER TABLE needs_you_marks ALTER COLUMN first_seen_at DROP NOT NULL;
${backfillOnceSql()}
`;
}

/** Current legacy report cells only: historical person tags never enter the new index. */
const NEEDS_YOU_MARKS_BACKFILL_ROWS = `
SELECT recipient.id identity_id,m.id message_id,room.workspace_id,NULL::timestamptz first_seen_at
FROM messages m JOIN rooms room ON room.id=m.room_id
JOIN identities recipient ON recipient.id=m.card->>'reportToId'
JOIN room_access member ON member.room_id=room.id AND member.identity_id=recipient.id AND member.removed_at IS NULL
LEFT JOIN needs_you_marks mark ON mark.identity_id=recipient.id AND mark.message_id=m.id
WHERE room.archived_at IS NULL AND ${viewerMemberSql('room.workspace_id', 'recipient.id')}
  AND ${questionForSql('recipient.id')}
  AND (mark.first_seen_at IS NULL OR mark.first_seen_at+interval '${NEEDS_YOU_EXPIRY_HOURS} hours'>now())`;

/** Run while installing the message trigger, before any new person-tag marks exist. */
function backfillOnceSql(): string {
  return `DO $needs_you_backfill$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM workflow_backfills WHERE name='needs-you-open-items-v1') THEN
      UPDATE needs_you_marks mark SET cleared_at=now() FROM messages m
      WHERE mark.message_id=m.id AND mark.cleared_at IS NULL AND m.presentation='message'
        AND (${questionForSql('mark.identity_id')}) IS NOT TRUE;
      INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at)
        ${NEEDS_YOU_MARKS_BACKFILL_ROWS} ON CONFLICT(identity_id,message_id) DO NOTHING;
      INSERT INTO workflow_backfills(name) VALUES('needs-you-open-items-v1') ON CONFLICT DO NOTHING;
    END IF;
  END $needs_you_backfill$;`;
}
