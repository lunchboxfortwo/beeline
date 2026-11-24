import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { IncomingMessage } from 'node:http';
import { DAEMON_OPERATION_NAMES } from './daemon/operation-names.js';
import type { SqlDatabase } from './database.js';

export function helperLogPath(path: string): string {
  const operation = path.slice('/v1/daemon/operations/'.length);
  if (path.startsWith('/v1/daemon/operations/') && DAEMON_OPERATION_NAMES.has(operation as keyof DaemonOperationMap)) return path;
  if (/^\/v1\/daemon\/(?:uploads|artifacts|media)$/.test(path)) return path;
  if (/^\/v1\/daemon\/uploads\/[0-9a-f-]+\/finalize$/.test(path)) return '/v1/daemon/uploads/:id/finalize';
  return '/v1/daemon/unknown';
}

export const helperRequestAgent = new WeakMap<IncomingMessage, string>();

export const helperRequestCommand = new WeakMap<IncomingMessage, string>();

export function commandLogField(value: unknown): string[] {
  return typeof value === 'string' && /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ? [`command=${value}`] : [];
}

const READS_PER_MINUTE = 300;
const conversationReads = new Set(['getRoomConversation', 'getRoomInbox', 'getRoomMessage', 'read']);
export const HELPER_READ_SCHEMA = `
CREATE TABLE IF NOT EXISTS helper_read_windows (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  reads integer NOT NULL
)`;

// The database serializes admissions across replicas and transports. Once a
// helper exhausts its window, refuse its burst locally until the window ends.
const refusals = new WeakMap<SqlDatabase, Map<string, number>>();

export async function helperReadRetryAfter(db: SqlDatabase, agentId: string, operation: string): Promise<number> {
  if (!conversationReads.has(operation)) return 0;
  const now = performance.now();
  let blocked = refusals.get(db);
  if (!blocked) {
    blocked = new Map();
    refusals.set(db, blocked);
  }
  const remaining = (blocked.get(agentId) ?? 0) - now;
  if (remaining > 0) return Math.ceil(remaining / 1000);
  const { rows } = await db.query<{ reads: number; remaining_ms: number }>(
    `INSERT INTO helper_read_windows AS w (agent_id, expires_at, reads)
     VALUES ($1, statement_timestamp() + interval '1 minute', 1)
     ON CONFLICT (agent_id) DO UPDATE SET
       reads = CASE WHEN w.expires_at <= statement_timestamp() THEN 1 ELSE LEAST(w.reads + 1, $2::int + 1) END,
       expires_at = CASE WHEN w.expires_at <= statement_timestamp() THEN EXCLUDED.expires_at ELSE w.expires_at END
     RETURNING reads, GREATEST(0, EXTRACT(epoch FROM expires_at - clock_timestamp()) * 1000)::int AS remaining_ms`,
    [agentId, READS_PER_MINUTE],
  );
  const window = rows[0]!;
  if (window.reads <= READS_PER_MINUTE) return 0;
  if (blocked.size >= 4096) blocked.clear();
  blocked.set(agentId, now + window.remaining_ms);
  return Math.max(1, Math.ceil(window.remaining_ms / 1000));
}
