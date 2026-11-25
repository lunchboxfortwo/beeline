import type { MessageAddress } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { CommandRefusalError } from './command-refusal.js';
import { assignmentBeforeBlock, commanderReportAddress } from './commander.js';
import type { SqlDatabase } from './database.js';
import { openBlocksSql } from './implementer-blocks.js';

type SessionMessage = {
  type: 'normal' | 'blocked' | 'reply';
  address?: string;
  quoteMsgId?: string;
  roomId: string;
  text: string;
};

export async function sendSessionMessage(database: SqlDatabase, agent: string, input: SessionMessage, parent?: CommandRow, id?: string, legacyAsk?:string) {
  const from = { agent, place: input.roomId };
  return database.transaction(async db => {
    if (typeof input.text !== 'string' || ['to','ask','question','brief','options'].some(field => field in input))
      throw new CommandRefusalError('Use text with blocked, reply and quoteMsgId, or normal and address.',400);
    let to: MessageAddress;
    let quote: string | undefined;
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
      const wake = parent?.message;
      if (!wake || wake.systemEvent || !wake.route || wake.type === 'system' || parent?.private_payload?.kind === 'lifecycle' || input.quoteMsgId !== wake.id)
        throw new CommandRefusalError('Quote a message that woke this turn.', 400);
      to = wake.route.from;
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
        const existing = (await db.query<{id:string}>(`SELECT id FROM (${openBlocksSql('$1')}) block WHERE author_id=$2`, [input.roomId,agent])).rows[0];
        if (existing && existing.id !== id) throw new CommandRefusalError('This worker already has an open block in the thread.',409);
      }
    } else {
      throw new CommandRefusalError('Use blocked alone, reply with quoteMsgId, or normal with address.',400);
    }
    return sendMessage(db,{type:input.type,route:{from,to},text:input.text,replyTo:quote,parent,id,legacyAsk});
  });
}
