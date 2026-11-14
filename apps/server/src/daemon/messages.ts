import { sanitizeTurnReplay } from '@beeline/api-contract/daemon';
import { answerQueuedMessage,queueMessage,turnRootMessageSql } from '../agent-command.js';
import { cornerRequestSql } from '../corner-opening.js';
import { type SqlDatabase } from '../database.js';
import { visibleMessageSql } from '../read-cursor.js';
import { daemonAccess } from './access.js';
import type { DaemonContext } from './context.js';
import { daemonWriteResult } from './corner-messages.js';
import { Input,MEDIA_URL_PATTERN } from './values.js';
import { modelText } from '../message-origin.js';

  export async function daemonCompletion(ctx: DaemonContext, input: Input<'getRequestCompletion'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    const row = (
      await ctx.database.query<{ corner_id: string | null; status: 'complete' | 'failed' | null; failure_reason: string | null }>(
        `SELECT (SELECT id::text FROM rooms WHERE parent_id=$1 AND ${cornerRequestSql('rooms.id')}=$2 LIMIT 1) corner_id,
          ended.status,ended.failure_reason FROM (SELECT 1) anchor LEFT JOIN LATERAL (
            SELECT CASE WHEN report_outcome='failed' THEN 'failed' ELSE state END status,cancellation_reason failure_reason FROM agent_commands
            WHERE room_id=$1 AND turn_request_id=$2 AND agent_id=$3 AND state='complete'
            ORDER BY created_at DESC LIMIT 1) ended ON true`,
        [input.roomId, input.requestId, agentId],
      )
    ).rows[0]!;
    return { ...(row.corner_id ? { openedCornerId: row.corner_id } : {}), completed: Boolean(row.status),
      ...(row.status ? { outcome: row.status, ...(row.failure_reason ? { failureReason: row.failure_reason } : {}) } : {}) };
  }

  export async function daemonPostRoomMessage(ctx: DaemonContext, input: Input<'postRoomMessage'>, agentId: string, _atomicCommandWrite = false) {
    if (input.presentation === 'card') {
      const saved = await queueMessage(ctx.database, { kind: 'post', roomId: input.roomId,
        authorId: agentId, text: modelText(input.text), requestId: input.requestId, presentation: 'card', tags: input.tags,
      });
      return { id: saved.id, createdAt: saved.createdAt };
    }
    return answerQueuedMessage(ctx.database, agentId, input);
  }

  export async function daemonPostAgentAttachment(ctx: DaemonContext, input: Input<'postAgentAttachment'>, agentId: string) {
    const attachment = input.attachment;
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment))
      throw new Error('attachment is required');
    if (typeof attachment.url !== 'string' || typeof attachment.name !== 'string')
      throw new Error('attachment url and name are required');
    if (
      typeof attachment.size !== 'number' ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size <= 0
    )
      throw new Error('attachment size is invalid');
    if (attachment.name.length > 512) throw new Error('attachment name is too long');
    if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 255)
      throw new Error('attachment mimeType is invalid');
    const mediaId = MEDIA_URL_PATTERN.exec(attachment.url)?.[1];
    if (!mediaId) throw new Error('attachment url is not a server media reference');
    const owned = await ctx.database.query<{ canonical: typeof attachment | null }>(
      `SELECT (SELECT file.part FROM agent_commands command
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(command.private_payload->'attachments','[]'::jsonb))
           WITH ORDINALITY file(part,position)
         JOIN objects carried ON carried.id::text=substring(file.part->>'url' from '/v1/media/([0-9a-f-]{36})')
           AND carried.sha256=uploaded.sha256 AND carried.state='ready' AND carried.expires_at>now()
         WHERE command.room_id=$3 AND command.agent_id=$2 AND command.turn_request_id=$4
         ORDER BY file.position LIMIT 1) canonical
       FROM objects uploaded
       WHERE uploaded.id=$1 AND uploaded.owner_id=$2 AND uploaded.state='ready' AND uploaded.expires_at>now()`,
      [mediaId, agentId, input.roomId, input.requestId],
    );
    if (!owned.rowCount) throw new Error('attachment media is not owned by this agent');
    // Deduplicate the upload inside its tool call, before it becomes answer data.
    const saved = owned.rows[0]?.canonical ?? attachment;
    // Older servers and brief tools still read the pending-media table during
    // this rolling release. The queue owns the answer's copy before upload returns.
    await ctx.database.query(
      `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [input.roomId,agentId,saved.url,saved.name,saved.mimeType,saved.size,input.requestId]);
    await ctx.database.query(
      `UPDATE agent_commands SET answer_attachments=answer_attachments || $4::jsonb
       WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3`,
      [input.roomId, agentId, input.requestId, JSON.stringify([saved])]);
    return daemonWriteResult(ctx);
  }

  export async function daemonLiveOutput(ctx: DaemonContext,
    kind: 'draft' | 'thought',
    input: Input<'postAgentDraft'>,
    agentId: string,
  ) {
    await daemonAccess(ctx, input.roomId, agentId);
    const written = await ctx.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       SELECT room.id,$2,$3,$4,$5::jsonb FROM rooms room
       WHERE room.id=$1 AND ($4<>'draft' OR room.parent_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM messages visit JOIN agent_commands command ON command.room_id=visit.room_id
           AND visit.card->'outputCommandIds' ? command.id
         WHERE visit.room_id=$1 AND visit.card_type='workflow-handoff'
           AND command.agent_id=$2 AND command.turn_request_id=$3 AND command.state='pending'
       ))
       ON CONFLICT(room_id,agent_id,turn_id,kind)
       DO UPDATE SET body=EXCLUDED.body,updated_at=now()
       RETURNING 1`,
      [input.roomId, agentId, input.turnId, kind, JSON.stringify({ text: input.text, latestChunk: input.latestChunk })],
    );
    // Room turns keep their durable working receipt and final reply, but their
    // provisional prose stays off the transcript. Corners retain the full
    // draft stream so repository work remains observable while it is running.
    if (!written.rowCount) return daemonWriteResult(ctx);
    ctx.live.publish({
      type: kind,
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      text: input.text,
      ...(input.latestChunk !== undefined ? { latestChunk: input.latestChunk } : {}),
      localOrigin: true,
    });
    return daemonWriteResult(ctx);
  }

  export async function daemonRetract(ctx: DaemonContext, input: Input<'retractAgentLiveOutput'>, agentId: string) {
    await ctx.database.query(
      `DELETE FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind=$4`,
      [input.roomId, agentId, input.turnId, input.kind],
    );
    ctx.live.publish({
      type: 'retract',
      roomId: input.roomId,
      agentId,
      turnId: input.turnId,
      kind: input.kind,
    });
    return daemonWriteResult(ctx);
  }

  export async function daemonPersistTurnTrace(ctx: DaemonContext, database: SqlDatabase, input: Input<'postAgentTurnReceipt'>, agentId: string): Promise<void> {
    // Diagnostics share the receipt transaction, but cannot fail the receipt.
    // IDs come from committed server rows, never a helper's claimed reply.
    if (input.trace) {
      await database.query('SAVEPOINT turn_trace');
      try {
        const trace = sanitizeTurnReplay(input.trace);
        if (trace) await database.query(
          `INSERT INTO agent_turn_traces(room_id,request_id,agent_id,trigger_message_id,
                                        reply_message_ids,outcome,trace)
           SELECT turn.room_id,turn.request_id,turn.agent_id,
             (SELECT id FROM messages WHERE id=${turnRootMessageSql('turn')}),
             COALESCE((SELECT jsonb_agg(reply.id ORDER BY reply.created_at,reply.id) FROM messages reply
               WHERE reply.room_id=turn.room_id AND reply.author_id=turn.agent_id
                 AND reply.request_id=turn.request_id AND reply.presentation IN ('message','card')
                 AND ${visibleMessageSql('reply')}),'[]'::jsonb),turn.status,$4::jsonb
           FROM agent_turns turn WHERE room_id=$1 AND request_id=$2 AND agent_id=$3
           ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
             trigger_message_id=EXCLUDED.trigger_message_id,
             reply_message_ids=EXCLUDED.reply_message_ids,outcome=EXCLUDED.outcome,
             trace=EXCLUDED.trace,created_at=now()`,
          [input.roomId,input.requestId,agentId,JSON.stringify(trace)],
        );
        await database.query('RELEASE SAVEPOINT turn_trace');
      } catch {
        await database.query('ROLLBACK TO SAVEPOINT turn_trace');
        await database.query('RELEASE SAVEPOINT turn_trace');
        console.warn('[turn-trace] trace dropped');
      }
    }
  }
