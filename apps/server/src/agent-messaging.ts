import { blockRecipient, refuseDoneWithBlocks } from './implementer-blocks.js';
import { lockAgentInvocation } from './agent-invocation.js';
import { Check, Errors } from 'typebox/value';
import { isInformationalReply, MESSAGE_ASK_SCHEMA, validateMessageAsk, reportMessageAsk, type MessageAddress, type MessageAsk, type MessageRoute } from '@beeline/api-contract/daemon';
import { randomBytes } from 'node:crypto';
import { answerQueuedMessage, queueMessage, refuseMessageMembership, type CommandRow } from './agent-command.js';
import { commandAddress } from './commander.js';
import { cornerCommanderIdSql } from './corner-commander.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import type { SqlDatabase } from './database.js';
import { modelText } from './message-origin.js';
import { postRoomChoice } from './room-choice.js';
import { updateWorkItem } from './work-board.js';

/** Validate the advertised ask schema before any lookup or publication. */
function validateAskInput(ask: MessageAsk): void {
  // Named limit refusals come first, so an over-long ask reports its counts.
  validateMessageAsk(ask);
  if (!Check(MESSAGE_ASK_SCHEMA, ask))
    throw new Error(Errors(MESSAGE_ASK_SCHEMA, ask).map(error => error.message).join('; '));
}

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

/** Speech that is stored but wakes no one says why in the same tool result, so the sender can correct it this turn. */
export const notWokenReceipt = (reason: string) => `Message stored and visible. No agents woken. ${reason}`;

/** Both publication paths commit their route alongside the message itself. */
export async function sendMessage(db: SqlDatabase, input: {
  route: MessageRoute; text: string; ask?: MessageAsk; question?: string; brief?: string; options?: readonly string[]; id?: string;
  parent?: CommandRow; replyTo?: string; attachments?: CommandRow['answer_attachments'];
}) {
  const reportAsk = reportMessageAsk(input);
  input = { ...input, ask: input.ask ?? reportAsk };
  if (input.ask) validateAskInput(input.ask);
  return db.transaction(async tx => {
    await refuseDoneWithBlocks(tx,input.route.from.agent,input.route.from.place,input.text);
    const reportStatus = /^(blocked|needs-decision):/i.exec(input.text.trim())?.[1]?.toLowerCase();
    const destination = await blockRecipient(tx,input.route.from,input.route.to,input.text);
    const to = input.replyTo ? destination : await messageAddress(tx,destination,input.route.from.agent);
    // A recorded reply can cross a private call site the worker never joined.
    // Its recipient still belongs there; the responder belongs at its own origin.
    const route = { from: input.route.from, to };
    const id = input.id ?? randomBytes(32).toString('hex');
    const human = (await tx.query("SELECT 1 FROM identities WHERE id=$1 AND kind='human'",[to.agent])).rowCount > 0;
    if (!human) {
      // Self-addressed speech and acknowledgements of informational replies
      // stay in the transcript without authorizing another agent turn.
      const self = to.agent === route.from.agent;
      // A commander or implementer may queue one turn for itself in its thread.
      // A turn a self-message started cannot queue another, so it cannot loop.
      const selfWake = self && !input.replyTo && Boolean(input.parent) && input.parent!.private_payload?.selfWake !== true &&
        (await tx.query(`SELECT 1 FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
          WHERE corner.id=$1 AND corner.archived_at IS NULL
            AND $2 IN (fact.implementer_agent_id,${cornerCommanderIdSql('corner')})`,[to.place,to.agent])).rowCount > 0;
      const transcriptOnly = self && !selfWake || Boolean(!reportStatus && input.replyTo && !input.ask &&
        isInformationalReply(input.parent?.reason, input.parent?.private_payload?.messageAsk));
      if (transcriptOnly && !(await tx.query(`SELECT 1 FROM room_access member
        JOIN rooms room ON room.id=member.room_id AND room.archived_at IS NULL
        WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL`,[to.place,to.agent])).rowCount)
        refuseMessageMembership();
      const command = transcriptOnly ? undefined : await queueMessage(tx, {
        id, roomId: to.place, agentId: to.agent,sourceMessageId:null,
        audienceId:input.replyTo ? to.agent : undefined,
        reason:reportStatus ? 'message' : input.replyTo ? 'reply' : 'message',parent:input.parent,
        privatePayload:{kind:input.replyTo ? 'reply' : 'message',route,messageAsk:input.ask,inReplyTo:input.replyTo,
          text:modelText(input.text),authorId:route.from.agent,fromRoomId:route.from.place,
          returnIdentityId:route.from.agent,attachments:input.attachments,...(selfWake ? {selfWake:true} : {})},
      });
      // A transcript reference shares a delivered command's identity, but is
      // never a source message or another wake. Room reads enforce place access;
      // card presentation keeps this reference out of agent conversation context.
      const recorded = await tx.query<{id:string;created_at:Date}>(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at,reply_to_message_id)
        SELECT $1,$2,$3,$4,CASE WHEN $8::text IS NULL THEN 'card' ELSE 'message' END,CASE WHEN $8::text IS NULL THEN 'agent-command' END,jsonb_build_object(
          'kind',$5::text,'text',$4::text,'recipient',jsonb_build_object(
            'id',recipient.id,'name',recipient.name,'kind',recipient.kind,
            'handle',beeline_room_handle(recipient.id,$2))) || CASE WHEN $8::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reportToId',$7::text,'reportStatus',$8::text,'sourceRoomId',$9::text) END,COALESCE($6::timestamptz,now()),(SELECT id FROM messages WHERE id=$10)
        FROM identities recipient WHERE recipient.id=$7
        ON CONFLICT(id) DO NOTHING RETURNING id,created_at`,
      [command?.id ?? id,to.place,route.from.agent,input.text,input.replyTo ? 'reply' : 'message',command?.created_at ?? null,to.agent,reportStatus ?? null,route.from.place,input.replyTo ?? (reportStatus ? input.parent?.id : undefined) ?? null]);
      const saved = recorded.rows[0] ?? (await tx.query<{id:string;created_at:Date}>(
        'SELECT id,created_at FROM messages WHERE id=$1',[command?.id ?? id])).rows[0]!;
      return { id:saved.id,createdAt:Math.floor(new Date(saved.created_at).getTime()/1000),
        ...(transcriptOnly ? { receipt: notWokenReceipt(to.agent === route.from.agent ? 'You addressed yourself; do the work in this turn.'
          : 'An acknowledgement of an informational reply wakes no one; add ask or use message() to reach them.') } : {}) };
    }
    if (input.ask) {
      const choice = await postRoomChoice(tx, {
        roomId: to.place, agentId: route.from.agent, requesterId: to.agent, mode: 'question',
        messageId: id, messageText: modelText(input.text), messageCard: { route, sourceRoomId: route.from.place, ...(reportStatus ? {reportStatus,reportToId:to.agent}: {}) },
        messageAttachments:input.attachments,messageOrigin:route.from,messageAudienceId:input.replyTo ? to.agent : undefined,
        prompt: input.ask.question, ask: input.ask.question, requestId: input.parent?.turn_request_id,
        options: input.ask.options.map(label => ({ label })),
      });
      const options = (await tx.query<{ options: { optionId: string; label: string }[] }>(
        'SELECT options FROM room_choices WHERE id=$1',[choice.choiceId])).rows[0]!.options;
      const origin=(await tx.query<{parent_id:string|null}>('SELECT parent_id FROM rooms WHERE id=$1',[route.from.place])).rows[0];
      const about=origin?.parent_id ? {kind:'thread',roomId:route.from.place}
        : {kind:'request',roomId:route.from.place,messageId:input.parent?.source_message_id ?? input.replyTo ?? id};
      await tx.query(`INSERT INTO work_questions(message_id,room_id,about,question,brief,recommended_option_id)
        VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(message_id) DO NOTHING`,
        [id,to.place,JSON.stringify(about),
          input.ask.question,input.ask.brief ?? null,options.find(option=>option.label===input.ask!.recommended)?.optionId ?? null]);
      await updateWorkItem(tx,{id,roomId:to.place,state:'needs-you',assigneeId:to.agent},route.from.agent,input.replyTo ? to.agent : undefined);
      return { id, createdAt: Math.floor(Date.now()/1000) };
    }
    const saved = await queueMessage(tx,{kind:'post',id,roomId:to.place,authorId:route.from.agent,
      origin:route.from,text:modelText(input.text),card:{route,sourceRoomId:route.from.place,...(reportStatus ? {reportStatus,reportToId:to.agent}: {})},agentIds:[],audienceId:input.replyTo ? to.agent : undefined,
      attachments:input.attachments,parent:input.parent,replyTo:input.parent?.source_message_id ?? input.replyTo ?? (reportStatus ? input.parent?.id : undefined),
      requestId:input.parent?.turn_request_id,commandRoomId:input.parent?.room_id});
    return { id:saved.id,createdAt:saved.createdAt };
  });
}

/** The caller supplies an id, never a reply destination. */
export async function replyToMessage(db: SqlDatabase, agentId: string, input: {
  id:string; text:string; invocation?:import('@beeline/api-contract/daemon').AgentInvocation; ask?:MessageAsk; question?:string; brief?:string; options?:readonly string[]; messageId?:string; roomId?:string; queuedRequestIds?:readonly string[];
},onAnswered?:(roomId:string)=>void) {
  const reportAsk = reportMessageAsk(input);
  input = { ...input, ask: input.ask ?? reportAsk };
  if (input.ask) validateAskInput(input.ask);
  return db.transaction(async db => {
  const invocation = input.invocation && input.roomId ? await lockAgentInvocation(db,agentId,input.roomId,input.invocation) : undefined;
  if (invocation?.state === 'cancelled') refuseMessageMembership('command turn cancelled');
  const item=(await db.query<CommandRow>(`SELECT * FROM agent_commands
    WHERE agent_id=$1 AND (id=$2 OR source_message_id=$2)
    ORDER BY (id=$2) DESC,created_at DESC LIMIT 1`,[agentId,input.id])).rows[0];
  if (!item) refuseMessageMembership();
  const saved=await answerQueuedMessage(db,agentId,{roomId:item.room_id,requestId:item.id,text:input.text,
    messageAsk:input.ask,messageId:input.messageId,explicitReply:true,replyFromPlace:input.roomId});
  if (!('answered' in saved) || saved.answered!==false) onAnswered?.(item.room_id);
  const owed = [...new Set(input.queuedRequestIds ?? [])];
  const completed = !input.ask && saved.delivered && input.roomId === item.room_id && owed.includes(item.turn_request_id) && owed.length
    ? (await db.query(`SELECT DISTINCT item.turn_request_id FROM agent_commands item JOIN messages reply
        ON reply.id=COALESCE(item.result_message_id,item.posted_reply_id)
        AND reply.author_id=item.agent_id AND reply.room_id=item.return_room_id AND reply.deleted_at IS NULL
      WHERE item.agent_id=$1 AND item.room_id=$2 AND item.turn_request_id=ANY($3::text[])
        AND item.state='complete'
        AND NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=reply.id)
        AND NOT EXISTS (SELECT 1 FROM agent_commands question WHERE question.id=reply.id
          AND question.private_payload->>'messageAsk' IS NOT NULL)`,[agentId,input.roomId,owed]).catch(error => {
        console.warn('[reply] optional completion proof unavailable:',error);
        return {rows:[]};
      })).rows.length === owed.length
    : false;
  return {...saved,...(completed ? {_meta:{beeline:{turnComplete:true}}} : {})};
  });
}
