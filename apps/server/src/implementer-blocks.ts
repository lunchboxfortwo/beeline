import { queueMessage, type CommandRow } from './agent-command.js';
import { modelText } from './message-origin.js';
import { refreshCornerAttention } from './corner-attention.js';
import type { SqlDatabase } from './database.js';
import { CommandRefusalError } from './command-refusal.js';
import { cornerCommanderIdSql, threadCommanderAddressSql } from './corner-commander.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { MessageAddress } from '@beeline/api-contract/daemon';

/** Blocks use the existing message and ask closure, independently of Tasks marks. */
export const IMPLEMENTER_BLOCKS_SCHEMA = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS block_corner_id uuid REFERENCES rooms(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS block_parent_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS block_reasked_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ask_closed_by text;
CREATE INDEX IF NOT EXISTS messages_open_blocks_idx ON messages(block_corner_id,created_at)
  WHERE block_corner_id IS NOT NULL AND ask_closed_reason IS NULL;
`;

export function openBlocksSql(corner: string): string {
  return `SELECT m.*,m.card->>'reportToId' holder_id FROM messages m
    JOIN rooms block_room ON block_room.id=COALESCE(m.block_corner_id,m.room_id) AND block_room.archived_at IS NULL
    WHERE (m.block_corner_id=${corner} OR (m.block_corner_id IS NULL AND m.block_parent_id IS NOT NULL AND (m.room_id=${corner} OR m.card->>'sourceRoomId'=(${corner})::text))) AND m.ask_closed_reason IS NULL AND m.deleted_at IS NULL`;
}

export async function blockReminder(db: SqlDatabase, agent: string, room: string): Promise<string> {
  const rows = (await db.query<{id:string;created_at:Date;holder:string;answered:boolean}>(`
    SELECT block.id,block.created_at,COALESCE(person.name,block.holder_id,'external event') holder,
      EXISTS(SELECT 1 FROM needs_you_marks mark WHERE mark.message_id=block.id AND mark.cleared_reason='answered') answered
    FROM (${openBlocksSql('$2')}) block
    LEFT JOIN corner_facts fact ON fact.corner_id=block.block_corner_id
    LEFT JOIN identities person ON person.id=block.holder_id
    WHERE fact.implementer_agent_id=$1 OR (block.block_corner_id IS NULL AND block.author_id=$1) ORDER BY block.created_at,block.id`,[agent,room])).rows;
  if (!rows.length) return '';
  return ['Your open blocks: clear those that no longer hold with close_ask(id, reason).',
    ...rows.slice(0,5).map(row=>`- ${row.id}: ${Math.max(0,Math.floor((Date.now()-new Date(row.created_at).getTime())/60000))}m old; holder: ${row.holder}; ${row.answered?'answered':'unanswered'}`),
    ...(rows.length>5?[`${rows.length-5} more`]:[]),
    'Reply in the block’s reply chain to re-ask. Answers clear Tasks, not blocks. Use plain text unless real options help. Use store_secret for credentials. If nobody can answer, set a scheduled or event wake when opening the block.',
  ].join('\n');
}

export async function refuseDoneWithBlocks(db:SqlDatabase,agent:string,room:string,text:string):Promise<void> {
  if (!/^done:/i.test(text.trim())) return;
  const reminder=await blockReminder(db,agent,room);
  if(reminder) throw new CommandRefusalError(`Clear your open blocks before reporting done.\n${reminder}`,409);
}

/** Default report routing follows the recorded opening commander. */
export async function blockRecipient(db:SqlDatabase,from:MessageAddress,to:MessageAddress,text:string):Promise<MessageAddress> {
  if(!/^(blocked|needs-decision):/i.test(text.trim())) return to;
  const row=(await db.query<{address:MessageAddress|null}>(`SELECT COALESCE(${threadCommanderAddressSql('room.id')},CASE WHEN $3::text=$4::text THEN jsonb_build_object('agent',(SELECT owner_id FROM agents WHERE agent_id=$2),'place',COALESCE(room.parent_id,room.id)) END) address
    FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id
    WHERE room.id=$1 AND fact.implementer_agent_id=$2`,[from.place,from.agent,to.agent,SYSTEM_IDENTITY_ID])).rows[0];
  return row?.address?.agent && row.address.agent!==from.agent ? row.address : to;
}

/** A takeover changes authority immediately; the original author retains no special rights. */
export async function closeBlock(db:SqlDatabase,actor:string,id:string,reason:string):Promise<boolean> {
  const block=(await db.query<{corner:string;worker:string;commander:string;workspace:string;parent:string}>(`
    SELECT room.id corner,CASE WHEN message.block_corner_id IS NULL THEN message.author_id ELSE fact.implementer_agent_id END worker,${cornerCommanderIdSql('room')} commander,
      room.workspace_id workspace,room.parent_id parent
    FROM messages message LEFT JOIN messages parent_block ON parent_block.id=message.block_parent_id
    JOIN rooms room ON room.id=COALESCE(message.block_corner_id,parent_block.block_corner_id)
    JOIN corner_facts fact ON fact.corner_id=room.id WHERE message.id=$1 FOR UPDATE OF message,room,fact`,[id])).rows[0];
  if(!block) return false;
  const member=(await db.query<{kind:string;role:string}>(`SELECT person.kind,member.role FROM identities person
    JOIN memberships member ON member.identity_id=person.id AND member.workspace_id=$2 AND member.room_id IS NULL AND member.removed_at IS NULL
    WHERE person.id=$1 AND EXISTS(SELECT 1 FROM room_access access WHERE access.room_id=$3 AND access.identity_id=$1 AND access.removed_at IS NULL)`,[actor,block.workspace,block.parent])).rows[0];
  if(!member || (actor!==block.worker && actor!==block.commander && member.kind!=='human'))
    throw new CommandRefusalError('Only the current implementer, its commander, or a person with higher standing can clear this block.',403);
  await db.query(`UPDATE messages SET ask_closed_reason=COALESCE(ask_closed_reason,$2),ask_closed_by=COALESCE(ask_closed_by,$3) WHERE id=$1`,[id,reason,actor]);
  await refreshCornerAttention(db,block.corner);
  return true;
}

/** A plain answer is a command for the block owner, even without a typed tag. */
export async function wakeBlockAnswer(db:SqlDatabase,replyId:string,room:string,author:string):Promise<CommandRow|undefined> {
  const block=(await db.query<{worker:string;place:string;text:string}>(`
    SELECT COALESCE(fact.implementer_agent_id,block.author_id) worker,
      COALESCE(block.block_corner_id,block.room_id) place,reply.text
    FROM messages reply JOIN messages block ON block.id=reply_block_root(reply.reply_to_message_id)
    LEFT JOIN corner_facts fact ON fact.corner_id=block.block_corner_id
    WHERE reply.id=$1 AND reply.room_id=$2 AND block.card->>'reportToId'=$3 AND block.ask_closed_reason IS NULL
      AND EXISTS(SELECT 1 FROM rooms owner_room JOIN room_access member ON member.room_id=COALESCE(owner_room.parent_id,owner_room.id)
        WHERE owner_room.id=COALESCE(block.block_corner_id,block.room_id) AND member.identity_id=COALESCE(fact.implementer_agent_id,block.author_id)
          AND member.removed_at IS NULL AND owner_room.archived_at IS NULL)
`,[replyId,room,author])).rows[0];
  if(!block) return;
  const existing=(await db.query<CommandRow>('SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2 AND room_id=$3',[replyId,block.worker,block.place])).rows[0];
  if(existing) return existing;
  return queueMessage(db,{roomId:block.place,agentId:block.worker,sourceMessageId:replyId,reason:'message',
    privatePayload:{kind:'message',text:modelText(block.text),
      authorId:author,fromRoomId:room,route:{from:{agent:author,place:room},to:{agent:block.worker,place:block.place}}}});
}
