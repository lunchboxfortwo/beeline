import { createHash } from 'node:crypto';
import { type CommittedTurnLiveRow } from '../live.js';
import type { DaemonContext } from './context.js';
import { Input, id, seconds } from './values.js';
import { daemonAccess } from './access.js';
import { daemonPersistTurnTrace } from './messages.js';



  /** Trace and usage for an item, written after its answer. Never changes the item. */
  export async function daemonTurnReceipt(ctx: DaemonContext, input: Input<'postAgentTurnReceipt'>, agentId: string) {
    // Wire-supplied counts are only ever stored when they are what they claim:
    // a negative, fractional, or absurd value is dropped, never clamped into a
    // measurement.
    const toolCalls =
      Number.isSafeInteger(input.toolCalls) &&
      (input.toolCalls ?? -1) >= 0 &&
      (input.toolCalls ?? 0) <= 100_000
        ? input.toolCalls!
        : null;
    const recordedTokens = (value: number | undefined) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_000_000_000
        ? value
        : null;
    const inputTokens = recordedTokens(input.totalInputTokens ?? input.inputTokens);
    const outputTokens = recordedTokens(input.outputTokens);
    let committedTurn: CommittedTurnLiveRow | undefined;
    await ctx.database.transaction(async db => {
      await db.query(`UPDATE agent_turns SET tool_calls=COALESCE($4,tool_calls),
        input_tokens=COALESCE($5,input_tokens),output_tokens=COALESCE($6,output_tokens)
        WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [input.roomId,input.requestId,agentId,toolCalls,inputTokens,outputTokens]);
      committedTurn = (await db.query<CommittedTurnLiveRow>(
        `SELECT room_id,request_id,agent_id,status,started_at,created_at,NULL::text requested_by
         FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [input.roomId,input.requestId,agentId])).rows[0];
      await daemonPersistTurnTrace(ctx, db, input, agentId);
    });
    ctx.live.publish({type:'invalidate',roomId:input.roomId,reason:'turn',agentId,requestId:input.requestId,
      ...(committedTurn ? {committedRow:{type:'turn' as const,row:committedTurn}} : {})});
  }


  export async function daemonActivity(ctx: DaemonContext, input: Input<'postAgentActivity'>, agentId: string) {
    await daemonAccess(ctx, input.roomId, agentId);
    const key = input.cornerActivityKey;
    if (key !== undefined) {
      if (typeof key !== 'string' || !key || key.length > 200)
        throw new Error('invalid corner activity key');
    }
    if (key !== undefined || input.activity.some((item) => item.kind === 'output')) {
      const corner = await ctx.database.query(`SELECT 1 FROM corner_facts WHERE corner_id=$1`, [
        input.roomId,
      ]);
      if (!corner.rowCount)
        throw new Error(
          key !== undefined
            ? 'invalid corner activity key: a corner is required'
            : 'invalid output activity: a corner is required',
        );
    }
    const messageId = key
      ? createHash('sha256')
          .update(JSON.stringify(['corner-activity', input.roomId, agentId, input.requestId, key]))
          .digest('hex')
      : id();
    // PostgreSQL jsonb cannot store NUL or lone UTF-16 surrogates. Replace
    // only those string characters, including nested fields, with U+FFFD.
    // Unicode mode keeps valid surrogate pairs (emoji, for example) intact.
    const serializedActivity = JSON.stringify(input.activity, (_key, value: unknown) =>
      typeof value === 'string' ? value.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD') : value,
    );
    const activity = await ctx.database.transaction(async (database) => {
      const inserted = await database.query<{ id: string; created_at: Date }>(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity,agent_model)
         VALUES($1,$2,$3,'','activity',$4,$5::jsonb,
           CASE WHEN $6::boolean THEN $7::text
             ELSE (SELECT selected_model FROM agents WHERE agent_id=$3) END)
         ON CONFLICT(id) DO NOTHING
         RETURNING id,created_at`,
        [
          messageId,
          input.roomId,
          agentId,
          input.requestId,
          serializedActivity,
          input.agentModel !== undefined,
          input.agentModel ?? null,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await database.query<{ id: string; created_at: Date }>(
            `SELECT id,created_at FROM messages
             WHERE id=$1 AND room_id=$2 AND author_id=$3 AND request_id=$4
               AND presentation='activity' AND activity=$5::jsonb`,
            [messageId, input.roomId, agentId, input.requestId, serializedActivity],
          )
        ).rows[0];
      if (!row) throw new Error('corner activity ID conflicts with another message');
      if (inserted.rowCount) {
        await database.query(
          `UPDATE agent_turns SET created_at=now()
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND status='working'`,
          [input.roomId, input.requestId, agentId],
        );
      }
      return { ...row, inserted: Boolean(inserted.rowCount) };
    });
    if (activity.inserted)
      ctx.live.publish({
        type: 'invalidate',
        roomId: input.roomId,
        reason: 'activity',
        agentId,
        messageId: activity.id,
      });
    return { id: activity.id, createdAt: seconds(activity.created_at) };
  }
