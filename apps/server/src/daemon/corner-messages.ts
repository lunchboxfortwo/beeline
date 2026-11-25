import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { answerQueuedMessage,authorizeCommandOutput,queueMessage,selectMcpMessage,type CommandRow,type QueuedPostReceipt } from '../agent-command.js';
import { CommandRefusalError } from '../commander.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { type SqlDatabase } from '../database.js';
import type { DaemonContext } from './context.js';
import { AccessDeniedError,Input,Output,id } from './values.js';
import { modelText } from '../message-origin.js';



  /** A public message; agent-authored tags never wake an agent. */
  export async function daemonPostCornerMessage(ctx: DaemonContext, input: {
    roomId: string; cornerId: string; text: string; replyTo?: string; requestId?: string;
    commandId?: string; attachments?: NonNullable<CommandRow['answer_attachments']>;
  }, agentId: string) {
    let completed = false;
    const result = await ctx.database.transaction(async db => {
      const parent = input.commandId ? await selectMcpMessage(db,agentId,input.commandId,input.cornerId)
        : input.requestId ? await authorizeCommandOutput(db,input.roomId,agentId,input.requestId) : undefined;
      if (input.commandId && !input.attachments && parent?.room_id === input.cornerId &&
          (parent.return_room_id ?? input.cornerId) === input.cornerId) {
        const saved = await answerQueuedMessage(db,agentId,{
          roomId:parent.room_id,requestId:parent.id,text:input.text,publicPost:true,replyToMessageId:input.replyTo,
        });
        completed = saved.completed && saved.published;
        return publicPostReceipt(input.cornerId,saved);
      }
      const saved = await queueMessage(db, { kind: 'post', roomId: input.cornerId,
        authorId: agentId, text: modelText(input.text), replyTo: input.replyTo,
        requestId: input.attachments ? undefined : parent?.turn_request_id,
        commandRoomId: parent?.room_id ?? input.roomId,
        parent, attachments: input.attachments ?? parent?.answer_attachments,
      });
      if (saved.stored && !input.attachments && parent?.answer_attachments?.length)
        await db.query('DELETE FROM agent_pending_attachments WHERE agent_id=$1 AND request_id=$2 AND url=ANY($3::text[])',
          [agentId,parent.turn_request_id,parent.answer_attachments.map(file=>file.url)]);
      return publicPostReceipt(input.cornerId,saved);
    });
    if (result.stored) ctx.live.publish({type:'invalidate',roomId:input.cornerId,reason:'message',agentId});
    if (completed) void ctx.reconcileZeroCheckWorkerCompletion(input.cornerId,agentId)
      .catch(error=>console.warn('[answer] optional lifecycle refresh omitted:',error));
    return result;
  }

  export function publicPostReceipt(address: string, saved: Partial<Pick<QueuedPostReceipt,
    'id' | 'createdAt' | 'woken' | 'notWoken' | 'stored' | 'visible' | 'receipt'>> & {messageId?: string}) {
    const messageId = saved.stored ? saved.messageId ?? saved.id ?? null : null;
    return { id: messageId, messageId, createdAt: messageId ? saved.createdAt : null, effect: 'conversation', address,
      visibility: 'public', reportsAssignment: false, woken: saved.woken ?? [], notWoken: saved.notWoken ?? [],
      stored: saved.stored ?? false, visible: saved.visible ?? false, receipt: saved.receipt ?? null };
  }


  /**
   * An agent reaches a corner when it is a current member of the corner or of
   * its parent Room. Returns the parent Room id.
   */
  export async function daemonReach(ctx: DaemonContext, cornerId: string, agentId: string, database: SqlDatabase = ctx.database) {
    database = new CornerAccessDatabase(database);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cornerId))
      throw new AccessDeniedError();
    const row = (
      await database.query<{ parent_id: string }>(
        `SELECT corner.parent_id FROM rooms corner
         WHERE corner.id=$1 AND corner.parent_id IS NOT NULL
           AND EXISTS(SELECT 1 FROM memberships member
                      WHERE member.room_id IN (corner.id,corner.parent_id)
                        AND member.identity_id=$2 AND member.removed_at IS NULL)`,
        [cornerId, agentId],
      )
    ).rows[0];
    if (!row) throw new AccessDeniedError();
    return row.parent_id;
  }


  /** Adds one fixed-vocabulary reaction without turning a retried tool call into an unreact. */
  export async function daemonReactToRoomMessage(ctx: DaemonContext,
    input: Input<'reactToRoomMessage'>,
    agentId: string,
  ): Promise<Output<'reactToRoomMessage'>> {
    if (!MESSAGE_REACTION_EMOJIS.includes(input.emoji)) throw new Error('reaction is invalid');
    await ctx.database.transaction(async (database) => {
      const row = (
        await database.query<{ reactions: Record<string, string[]> }>(
          `SELECT reactions FROM messages
           WHERE id=$1 AND room_id=$2 AND presentation='message'
           FOR UPDATE`,
          [input.messageId, input.roomId],
        )
      ).rows[0];
      if (!row) throw new CommandRefusalError('message is not available for reaction', 404);
      const reactions = { ...(row.reactions ?? {}) };
      const reactors = new Set(reactions[input.emoji] ?? []);
      reactors.add(agentId);
      reactions[input.emoji] = [...reactors];
      await database.query(`UPDATE messages SET reactions=$3::jsonb WHERE id=$1 AND room_id=$2`, [
        input.messageId,
        input.roomId,
        JSON.stringify(reactions),
      ]);
    });
    ctx.live.publish({
      type: 'invalidate',
      roomId: input.roomId,
      reason: 'message',
      messageId: input.messageId,
      agentId,
    });
    return daemonWriteResult(ctx);
  }

  export function daemonWriteResult(ctx: DaemonContext, extra?: {
    failureReportDelivered?: boolean;
  }) {
    return { id: id(), createdAt: Math.floor(Date.now() / 1000), ...extra };
  }
