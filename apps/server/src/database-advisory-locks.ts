import { createHmac, randomBytes } from 'node:crypto';
import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';

export const AGENT_PLACE_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('agent-place:' || $1 || ':' || $2, 0))";
export const ROUTER_AUTHORITY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))';

type AdvisoryLockKey = typeof ROUTER_AUTHORITY_LOCK | `agent-place:${string}`;

// Correlate lock reports within this process using an in-memory key.
const agentPlaceLogKey = randomBytes(32);

export function statementAdvisoryLockKey(sql: string, values: unknown[]): AdvisoryLockKey | undefined {
  if (sql === AGENT_PLACE_LOCK_SQL) {
    const [agentId, roomId] = values;
    if (typeof agentId === 'string' && typeof roomId === 'string') {
      const identifier = createHmac('sha256', agentPlaceLogKey)
        .update(`agent-place:${agentId}:${roomId}`).digest('hex').slice(0, 32);
      return `agent-place:${identifier}`;
    }
  }
  if (sql === ROUTER_AUTHORITY_LOCK_SQL && values[0] === ROUTER_AUTHORITY_LOCK) return ROUTER_AUTHORITY_LOCK;
}

const ROUTER_AUTHORITY_LOCK_NOTICE = 'BL001';

// PostgreSQL releases transaction locks on abort. Mark the trigger's key while
// the transaction is still live, once per transaction on Beeline connections.
// INFO goes to the client as a notice, below the default server log threshold.
export const ROUTER_AUTHORITY_TRIGGER_LOCK_SQL = `
 IF current_setting('application_name') LIKE 'beeline#_%' ESCAPE '#'
   AND current_setting('beeline.router_authority_lock_seen', true) IS DISTINCT FROM '1' THEN
   PERFORM set_config('beeline.router_authority_lock_seen', '1', true);
   RAISE INFO USING ERRCODE='${ROUTER_AUTHORITY_LOCK_NOTICE}', MESSAGE='${ROUTER_AUTHORITY_LOCK}';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('${ROUTER_AUTHORITY_LOCK}',0));`;

export function noticeAdvisoryLockKey(notice: { code?: string; message?: string }): AdvisoryLockKey | undefined {
  if (notice.code === ROUTER_AUTHORITY_LOCK_NOTICE && notice.message === ROUTER_AUTHORITY_LOCK)
    return ROUTER_AUTHORITY_LOCK;
}
