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
      throw new CommandRefusalError('Use text with blocked, reply and quoteMsgId, or normal and address.',400);
    let to: MessageAddress;
    let quote: string | undefined;
    let openBlockIds: string[] = [];
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
    } else if (input.type === 'reply' && typeof input.quoteMsgId === 'string' && input.address === undefined) {
      const wake = replyableWake(parent);
      if (parent?.state !== 'pending' || input.quoteMsgId !== wake?.id)
        throw new CommandRefusalError('Quote a message that woke this turn.', 400);
      to = (await recordedMessageRoute(db, parent)).from;
      quote = input.quoteMsgId;
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
        openBlockIds = (await db.query<{id:string}>(`SELECT id FROM (${openBlocksSql('$1')}) block WHERE author_id=$2 ORDER BY created_at,id`, [input.roomId,agent]))
          .rows.map((row) => row.id);
      }
    } else {
      throw new CommandRefusalError('Use blocked alone, reply with quoteMsgId, or normal with address.',400);
    }
    const saved = await sendMessage(db,{type:input.type,route:{from,to},text:input.text,replyTo:quote,parent,id});
    if (parent && saved.messageId && (quote || input.type === 'blocked')) await db.query(
      'UPDATE agent_commands SET posted_reply_id=$2 WHERE id=$1', [parent.id,saved.messageId]);
    if (input.type === 'blocked' && saved.messageId && openBlockIds.length) {
      const replaced = await supersedeOpenBlocks(db, input.roomId, agent, saved.messageId, openBlockIds);
      if (replaced.length && saved.receipt) {
        return { ...saved, receipt: `${saved.receipt} · superseded previous block ${replaced.map((oldId) => oldId.slice(0, 8)).join(', ')}` };
      }
    }
    return saved;
  });
}
