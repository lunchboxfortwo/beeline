import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { DIAGNOSTIC_UUID, parseDiagnosticBatch, type DiagnosticAck, type DiagnosticStep } from '@beeline/api-contract/diagnostics';
import type { SqlDatabase } from './database.js';
import { PHONE_OPERATION_NAMES } from './phone/operation-names.js';

export type DiagnosticOrigin = { deviceId: string; sessionId: string; viewId: string; actionId: string; requestId: string };
const context = new AsyncLocalStorage<{ userId: string; origin?: DiagnosticOrigin }>();
export const diagnosticContext = () => context.getStore();
export function parseDiagnosticOrigin(raw: unknown): DiagnosticOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const v = raw as Record<string,unknown>;
  const keys = ['deviceId','sessionId','viewId','actionId','requestId'];
  if (Object.keys(v).length !== keys.length || !keys.every(k => typeof v[k] === 'string' && DIAGNOSTIC_UUID.test(v[k] as string))) return;
  return v as DiagnosticOrigin;
}
export function withDiagnosticContext<T>(userId: string, origin: DiagnosticOrigin | undefined, work: () => T): T {
  return context.run({ userId,origin },work);
}

export async function ingestDiagnostics(db: SqlDatabase, raw: unknown, userId?: string, familyId?: string): Promise<DiagnosticAck> {
  const batch = parseDiagnosticBatch(raw,PHONE_OPERATION_NAMES);
  if (!batch) throw new Error('invalid_diagnostic_batch');
  const hash = createHash('sha256').update(batch.bindingKey).digest('hex');
  return db.transaction(async tx => {
    await tx.query(`INSERT INTO diagnostic_devices(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen=now()`,[batch.deviceId]);
    const session = await tx.query(`INSERT INTO diagnostic_sessions(id,device_id,view_id,binding_hash,user_id,auth_family_id,descriptor)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT(id) DO UPDATE SET last_seen=now(),user_id=COALESCE(diagnostic_sessions.user_id,EXCLUDED.user_id),
        auth_family_id=COALESCE(EXCLUDED.auth_family_id,diagnostic_sessions.auth_family_id)
      WHERE diagnostic_sessions.binding_hash=EXCLUDED.binding_hash AND diagnostic_sessions.device_id=EXCLUDED.device_id
        AND diagnostic_sessions.view_id=EXCLUDED.view_id
        AND (diagnostic_sessions.user_id IS NULL OR diagnostic_sessions.user_id=EXCLUDED.user_id)
      RETURNING id`,[batch.sessionId,batch.deviceId,batch.viewId,hash,userId ?? null,familyId ?? null,JSON.stringify(batch.descriptor)]);
    if (!session.rowCount) throw new Error('diagnostic_session_conflict');
    // All events are one append, not per-event requests or overwriting screen visits.
    const result = await tx.query<{ event_id: string }>(`WITH input AS (
      SELECT value e FROM jsonb_array_elements($1::jsonb)
    ), admitted AS (
      INSERT INTO diagnostic_event_keys(event_id,session_id)
      SELECT (e->>'eventId')::uuid,$2::uuid FROM input ON CONFLICT DO NOTHING RETURNING event_id
    ) INSERT INTO diagnostic_actions(event_id,session_id,user_id,source,occurred_at,sequence,action_id,command_id,detail)
      SELECT a.event_id,$2,$3,'client',(i.e->>'occurredAt')::timestamptz,(i.e->>'sequence')::bigint,
        (i.e->>'actionId')::uuid,i.e->>'commandId',i.e-'eventId'-'occurredAt'-'sequence'
      FROM input i JOIN admitted a ON a.event_id=(i.e->>'eventId')::uuid RETURNING event_id`,
    [JSON.stringify(batch.events),batch.sessionId,userId ?? null]);
    // A duplicate is acknowledged only if its original session matches; another session cannot steal an id.
    const acknowledged = await tx.query<{ event_id: string }>(`SELECT event_id FROM diagnostic_event_keys
      WHERE session_id=$1 AND event_id=ANY($2::uuid[])`,[batch.sessionId,batch.events.map(e=>e.eventId)]);
    void result;
    return { accepted: acknowledged.rows.map(r=>r.event_id) };
  });
}

/** Optional diagnostics never change a domain operation's result after commit. */
export async function recordDiagnostic(db: SqlDatabase, step: DiagnosticStep, userId?: string, source: 'server'|'agent' = 'server'): Promise<void> {
  const c = diagnosticContext();
  const user = userId ?? c?.userId ?? null;
  const origin = c?.origin;
  await db.query(`INSERT INTO diagnostic_actions(event_id,session_id,user_id,source,occurred_at,action_id,command_id,detail)
    VALUES($1,COALESCE((SELECT id FROM diagnostic_sessions WHERE id=$2 AND user_id=$3),
      (SELECT session_id FROM diagnostic_command_origins WHERE command_id=$6 AND user_id=$3)),$3,$4,now(),$5,$6,$7::jsonb)`,
  [randomUUID(),origin?.sessionId ?? null,user,source,step.actionId ?? origin?.actionId ?? null,step.commandId ?? null,
    JSON.stringify({ ...step, ...(origin ? { requestId: origin.requestId } : {}) })]);
}

/** Invoked by existing maintenance, never a new diagnostic timer. */
export async function compactDiagnostics(db: SqlDatabase): Promise<void> {
  await db.query(`DELETE FROM diagnostic_actions WHERE received_at<now()-interval '30 days'`);
  await db.query(`DELETE FROM diagnostic_sessions WHERE last_seen<now()-interval '30 days'
    OR (user_id IS NULL AND last_seen<now()-interval '7 days')`);
  await db.query(`DELETE FROM diagnostic_devices WHERE last_seen<now()-interval '90 days'`);
  await db.query(`DELETE FROM diagnostic_reads WHERE read_at<now()-interval '30 days'`);
}
