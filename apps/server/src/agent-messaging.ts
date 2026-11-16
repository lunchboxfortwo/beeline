import { validateMessageAsk, type MessageAddress, type MessageAsk, type MessageRoute } from '@beeline/api-contract/daemon';
import { randomBytes } from 'node:crypto';
import { answerQueuedMessage, queueMessage, refuseMessageMembership, type CommandRow } from './agent-command.js';
import { commandAddress } from './commander.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import type { SqlDatabase } from './database.js';
import { modelText } from './message-origin.js';
import { postRoomChoice } from './room-choice.js';
import { updateWorkItem } from './work-board.js';

/** Resolve both coordinates together; a role is meaningful only at its thread. */
export async function messageAddress(db: SqlDatabase, to: MessageAddress, sender: string): Promise<MessageAddress> {
  const place = await commandAddress(db, to.place, sender);
  const target = (await db.query<{ id: string }>(`SELECT identity.id FROM rooms room
    JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id) AND member.removed_at IS NULL
    JOIN identities identity ON identity.id=member.identity_id
    LEFT JOIN rooms parent ON parent.id=room.parent_id
    WHERE room.id=$1 AND CASE WHEN $2='implementer' THEN identity.id=$3
      WHEN $2='reviewer' THEN identity.id=${cornerReviewerSql('room','parent')}
      ELSE identity.id=$2 OR lower(beeline_workspace_handle(identity.id,room.workspace_id))=lower(ltrim($2,'@')) END`,
    [place.id,to.agent,place.worker])).rows[0];
  return { agent: target?.id ?? to.agent, place: place.id };
}

/** Both publication paths commit their route alongside the message itself. */
export async function sendMessage(db: SqlDatabase, input: {
  route: MessageRoute; text: string; ask?: MessageAsk; id?: string;
  parent?: CommandRow; replyTo?: string; attachments?: CommandRow['answer_attachments'];
}) {
  if (input.ask) validateMessageAsk(input.ask);
  return db.transaction(async tx => {
    const to = input.replyTo ? input.route.to : await messageAddress(tx,input.route.to,input.route.from.agent);
    // A recorded reply can cross a private call site the worker never joined.
    // Its recipient still belongs there; the responder belongs at its own origin.
    const route = { from: input.route.from, to };
    const id = input.id ?? randomBytes(32).toString('hex');
    const human = (await tx.query("SELECT 1 FROM identities WHERE id=$1 AND kind='human'",[to.agent])).rowCount > 0;
    if (!human) {
      const command = await queueMessage(tx, {
        id, roomId: to.place, agentId: to.agent,sourceMessageId:null,
        audienceId:input.replyTo ? to.agent : undefined,
        reason:input.replyTo ? 'reply' : 'message',parent:input.parent,
        privatePayload:{kind:input.replyTo ? 'reply' : 'message',route,messageAsk:input.ask,inReplyTo:input.replyTo,
          text:modelText(input.text),authorId:route.from.agent,fromRoomId:route.from.place,
          returnIdentityId:route.from.agent,attachments:input.attachments},
      });
      return { id:command!.id,createdAt:Math.floor(new Date(command!.created_at).getTime()/1000) };
    }
    if (input.ask) {
      const choice = await postRoomChoice(tx, {
        roomId: to.place, agentId: route.from.agent, requesterId: to.agent, mode: 'question',
        messageId: id, messageText: modelText(input.text), messageCard: { route, sourceRoomId: route.from.place },
        messageAttachments:input.attachments,messageOrigin:route.from,messageAudienceId:input.replyTo ? to.agent : undefined,
        prompt: input.ask.question, ask: input.ask.question, requestId: input.parent?.turn_request_id,
        options: input.ask.options.map(label => ({ label, consequence: label })),
      });
      const options = (await tx.query<{ options: { optionId: string; label: string }[] }>(
        'SELECT options FROM room_choices WHERE id=$1',[choice.choiceId])).rows[0]!.options;
      const origin=(await tx.query<{parent_id:string|null}>('SELECT parent_id FROM rooms WHERE id=$1',[route.from.place])).rows[0];
      const about=origin?.parent_id ? {kind:'thread',roomId:route.from.place}
        : {kind:'request',roomId:route.from.place,messageId:input.parent?.source_message_id ?? input.replyTo ?? id};
      await tx.query(`INSERT INTO work_questions(message_id,room_id,about,question,recommended_option_id)
        VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(message_id) DO NOTHING`,
        [id,to.place,JSON.stringify(about),
          input.ask.question,options.find(option=>option.label===input.ask!.recommended)?.optionId ?? null]);
      await updateWorkItem(tx,{id,roomId:to.place,state:'needs-you',assigneeId:to.agent},route.from.agent,input.replyTo ? to.agent : undefined);
      return { id, createdAt: Math.floor(Date.now()/1000) };
    }
    const saved = await queueMessage(tx,{kind:'post',id,roomId:to.place,authorId:route.from.agent,
      origin:route.from,text:modelText(input.text),card:{route,sourceRoomId:route.from.place},agentIds:[],audienceId:input.replyTo ? to.agent : undefined,
      attachments:input.attachments,parent:input.parent,replyTo:input.parent?.source_message_id ?? input.replyTo,
      requestId:input.parent?.turn_request_id,commandRoomId:input.parent?.room_id});
    return { id:saved.id,createdAt:saved.createdAt };
  });
}

/** The caller supplies an id, never a reply destination. */
export async function replyToMessage(db: SqlDatabase, agentId: string, input: {
  id:string; text:string; ask?:MessageAsk; messageId?:string; roomId?:string;
},onAnswered?:(roomId:string)=>void) {
  if (input.ask) validateMessageAsk(input.ask);
  const item=(await db.query<CommandRow>(`SELECT * FROM agent_commands
    WHERE agent_id=$1 AND (id=$2 OR source_message_id=$2)
    ORDER BY (id=$2) DESC,created_at DESC LIMIT 1`,[agentId,input.id])).rows[0];
  if (!item) refuseMessageMembership();
  const saved=await answerQueuedMessage(db,agentId,{roomId:item.room_id,requestId:item.id,text:input.text,
    messageAsk:input.ask,messageId:input.messageId,explicitReply:true,replyFromPlace:input.roomId});
  if (!('answered' in saved) || saved.answered!==false) onAnswered?.(item.room_id);
  return saved;
}
