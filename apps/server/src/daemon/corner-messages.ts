import { MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';
import { authorizeCommandOutput,queueMessage,type QueuedPostReceipt } from '../agent-command.js';
import { CommandRefusalError } from '../commander.js';
import { CornerAccessDatabase } from '../corner-access-database.js';
import { type SqlDatabase } from '../database.js';
import type { DaemonContext } from './context.js';
import { AccessDeniedError,Input,Output,id } from './values.js';
import { modelText } from '../message-origin.js';



  /** A public message; agent-authored tags never wake an agent. */
  export async function daemonPostCornerMessage(ctx: DaemonContext, input: {roomId:string; cornerId:string; text:string; requestId?:string; replyTo?:string}, agentId: string) {
    const parent = input.requestId ? await authorizeCommandOutput(ctx.database,input.roomId,agentId,input.requestId) : undefined;
    const saved = await queueMessage(ctx.database, { kind: 'post', roomId: input.cornerId,
      authorId: agentId, text: modelText(input.text), replyTo: input.replyTo,
      requestId: input.requestId, commandRoomId: input.roomId,
      parent, attachments: parent?.answer_attachments,
    });
    if (saved.stored && parent?.answer_attachments?.length) void ctx.database.query(
      'DELETE FROM agent_pending_attachments WHERE agent_id=$1 AND request_id=$2 AND url=ANY($3::text[])',
      [agentId,input.requestId,parent.answer_attachments.map(file=>file.url)])
      .catch(error=>console.warn('[post] optional media cleanup omitted:',error));
    ctx.live.publish({ type: 'invalidate', roomId: input.cornerId, reason: 'message', agentId });
    return publicPostReceipt(input.cornerId, saved);
  }

  export function publicPostReceipt(address: string, saved: Pick<QueuedPostReceipt, 'id' | 'createdAt'> &
    Partial<Pick<QueuedPostReceipt, 'woken' | 'notWoken' | 'stored' | 'visible' | 'receipt'>>) {
    return { id: saved.id, createdAt: saved.createdAt, effect: 'conversation', address,
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
