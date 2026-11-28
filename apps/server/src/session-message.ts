import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { MessageAddress } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { CommandRefusalError } from './command-refusal.js';
import { assignmentBeforeBlock, commanderReportAddress } from './commander.js';
import type { SqlDatabase } from './database.js';
import { openBlocksSql, supersedeOpenBlocks } from './implementer-blocks.js';
import { recordedMessageRoute, replyableWake } from './message-route.js';

type SessionMessage = {
  type: 'normal' | 'blocked' | 'reply';
  address?: string;
  quoteMsgId?: string;
  roomId: string;
  text: string;
};

export async function sendSessionMessage(database: SqlDatabase, agent: string, input: SessionMessage, parent?: CommandRow, id?: string) {
  const from = { agent, place: input.roomId };
  return database.transaction(async db => {
    if (typeof input.text !== 'string' || ['to','ask','question','brief','options'].some(field => field in input))
      throw new CommandRefusalError('Send text with type "reply", "blocked", or "normal".',400);
    let to: MessageAddress;
    let quote: string | undefined;
    let attachments: CommandRow['answer_attachments'];
    let openBlockIds: string[] = [];
    let existed = false;
    if (input.type === 'normal' && typeof input.address === 'string' && input.quoteMsgId === undefined) {
      const parts = input.address.split('@');
      const [recipient, place] = parts;
      const target = parts.length === 2 && (await db.query<{agent: string; place: string; allowed: boolean}>(`
        SELECT identity.id agent, target.id place, origin.parent_id IS NULL OR target.parent_id IS NOT NULL allowed
        FROM rooms target JOIN rooms origin ON origin.id=$1
        JOIN identities identity ON identity.id=$2 AND identity.kind='agent'
        WHERE target.id::text=$3`, [input.roomId, recipient, place])).rows[0];
      if (!target) throw new CommandRefusalError('Address an agent session as agentId@placeId.',400);
      if (!target.allowed) throw new CommandRefusalError('A thread must address a thread agent session.', 400);
      to = {agent: target.agent, place: target.place};
    } else if (input.type === 'reply' && input.address === undefined) {
      const wake = replyableWake(parent);
      if (!wake || parent?.state !== 'pending' || (input.quoteMsgId !== undefined && input.quoteMsgId !== wake.id))
        throw new CommandRefusalError('Quote a message that woke this turn, or omit quoteMsgId to reply to the current request.', 400);
      to = (await recordedMessageRoute(db, parent)).from;
      quote = wake.id;
      // Files uploaded this turn go with a reply to a person in this place.
      // Elsewhere they stay with the closing text, so this place still gets them.
      // A retry of a saved reply sends the files that reply already took, so it is not posted again.
      const replayed = id ? (await db.query<{ attachments: CommandRow['answer_attachments'] }>(
        'SELECT attachments FROM messages WHERE id=$1 AND author_id=$2', [id, agent])).rows[0] : undefined;
      if (replayed) attachments = replayed.attachments?.length ? replayed.attachments : undefined;
      else if (parent.answer_attachments?.length && to.place === input.roomId &&
          (await db.query("SELECT 1 FROM identities WHERE id=$1 AND kind='human'", [to.agent])).rowCount)
        attachments = parent.answer_attachments;
    } else if (input.type === 'blocked' && input.address === undefined && input.quoteMsgId === undefined) {
      const room = (await db.query<{ parent_id: string | null; created_by: string }>(
        'SELECT parent_id,created_by FROM rooms WHERE id=$1 FOR UPDATE', [input.roomId])).rows[0];
      const escalating = parent?.private_payload?.reportStatus === 'blocked';
      const assignment = escalating ? await assignmentBeforeBlock(db,parent) : parent;
      const order = assignment?.private_payload;
      let taskSender:MessageAddress | undefined;
      if (order?.kind === 'order' && order.fromRoomId) {
        taskSender = {agent:order.authorId,place:order.fromRoomId};
      } else if (assignment?.reason === 'message' || assignment?.reason === 'schedule') {
        taskSender = (assignment.message?.route ?? order?.route)?.from;
      } else if (!assignment && escalating && !room?.parent_id) {
        taskSender = (await db.query<MessageAddress>(`SELECT source.author_id agent,source.room_id place FROM messages source
          JOIN identities author ON author.id=source.author_id AND author.kind='human'
          WHERE source.id=$1 AND source.room_id=$2 AND source.system_event IS NULL`,[parent.root_source_message_id,input.roomId])).rows[0];
      }
      const route = taskSender && (taskSender.agent !== agent || taskSender.place !== input.roomId)
        ? {recipient:taskSender.agent, returnRoom:taskSender.place}
        : await commanderReportAddress(db,input.roomId,assignment);
      const recipient = route?.recipient ?? room?.created_by;
      const place = route?.returnRoom ?? room?.parent_id;
      if (!recipient || !place || recipient === agent && place === input.roomId)
        throw new CommandRefusalError('No commander is recorded for this session.', 400);
      to = {agent: recipient, place};
      if (room?.parent_id) {
        if (id) existed = (await db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount > 0;
        openBlockIds = (await db.query<{id:string}>(`SELECT id FROM (${openBlocksSql('$1')}) block WHERE author_id=$2 ORDER BY created_at,id`, [input.roomId,agent]))
          .rows.map((row) => row.id);
      }
    } else {
      throw new CommandRefusalError('Send type "reply" with text to answer this turn. Send type "normal" with text and address to ask another agent. Send type "blocked" with text to report a block.',400);
    }
    const saved = await sendMessage(db,{type:input.type,route:{from,to},text:input.text,replyTo:quote,parent,id,attachments});
    const replayed = existed && saved.messageId === id;
    if (parent && saved.messageId && !replayed && (quote || input.type === 'blocked')) await db.query(
      // Only the reply tool records reply_tool_message_id; a later closing text checks it.
      `UPDATE agent_commands SET posted_reply_id=$2${input.type === 'reply' ? ',reply_tool_message_id=$2' : ''} WHERE id=$1`, [parent.id,saved.messageId]);
    if (input.type === 'blocked' && saved.messageId && openBlockIds.length && !replayed) {
      const createdOpenBlock = (await db.query(`SELECT 1 FROM (${openBlocksSql('$1')}) block WHERE id=$2`, [input.roomId, saved.messageId])).rowCount > 0;
      if (createdOpenBlock) {
        const replaced = await supersedeOpenBlocks(db, input.roomId, agent, saved.messageId, openBlockIds);
        if (replaced.length && saved.receipt) {
          return { ...saved, receipt: `${saved.receipt} · superseded previous block ${replaced.map((oldId) => oldId.slice(0, 8)).join(', ')}` };
        }
      }
    }
    return saved;
  });
}
