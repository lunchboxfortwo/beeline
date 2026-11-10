import type { SqlDatabase } from './database.js';
import { queryFingerprint } from './query-profile.js';

/** Strip values before any query text crosses the logging boundary. Fail closed
 * on truncated strings/comments (pg_stat_activity can truncate query text). */
export function diagnosticSql(sql: string): string {
  let result = '';
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      result += ' ';
    } else if (rest.startsWith('/*')) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      result += ' ';
    } else if (sql[i] === "'" || sql[i] === '"') {
      // Only E strings interpret backslashes as escapes. Ordinary strings
      // depend on standard_conforming_strings, which an activity sample does
      // not carry. Suppress ambiguous text rather than guess that setting.
      const escape = sql[i] === "'" && /(?:^|[^\p{L}\p{N}_$])E$/iu.test(sql.slice(0, i));
      const quote = sql[i++]!;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          if (escape) { i += 2; continue; }
          if (quote === "'") return '[SQL redacted]';
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          break;
        }
      }
      result += '?';
    } else {
      const dollar = rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
      if (dollar) {
        const end = sql.indexOf(dollar, i + dollar.length);
        i = end < 0 ? sql.length : end + dollar.length;
        result += '?';
      } else {
        const number = rest.match(/^(?:\$\d+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)?.[0];
        if (number) { i += number.length; result += '?'; }
        else { result += sql[i++]; }
      }
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

type Blocker = {
  waiting_pid: number;
  blocking_pid: number;
  blocking_query: string | null;
  blocking_query_id: string | null;
  blocking_state: string | null;
  transaction_age_ms: number | null;
};
type Watch = { pid: number; observedAt?: number; blockers: Blocker[]; sampled: boolean; failed: boolean };

/** Statement starts/completions admit at most one probe per 100ms on the existing
 * diagnostics pool; there is no diagnostic clock or background polling. Observe before
 * cancellation: pg_blocking_pids is empty after a lock timeout releases a wait.
 * No SQL replay, new pool, or wait for diagnostics on the request path. */
export class DatabaseLockDiagnostics {
  readonly #watches = new Set<Watch>();
  #probing = false;
  #lastProbeAt = -Infinity;

  constructor(private readonly observer: SqlDatabase) {}

  async statement<T>(pid: number | undefined, sql: string, work: () => Promise<T>): Promise<T> {
    if (/^\s*(?:BEGIN\b|SET\s)/i.test(sql)) return work();
    const watch: Watch = { pid: pid ?? 0, blockers: [], sampled: false, failed: !pid };
    if (pid) this.#watches.add(watch);
    try {
      const pending = work();
      // Send the statement first, then observe on another physical connection.
      void this.#sample();
      return await pending;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '55P03' || code === '40P01' || (code === '57014' && watch.blockers.length)) {
        console.warn('[database] lock timeout', {
          code, waitingPid: pid, statement: diagnosticSql(sql).slice(0, 1000),
          statementFingerprint: queryFingerprint(diagnosticSql(sql)),
          observedAt: watch.observedAt,
          observation: watch.blockers.length ? 'captured' : watch.failed ? 'unavailable' : watch.sampled ? 'no-blocker-observed' : 'not-sampled',
          blockers: watch.blockers.map(({ blocking_query, ...blocker }) => ({
            ...blocker,
            query: blocking_query === null ? null : diagnosticSql(blocking_query).slice(0, 1000),
            queryFingerprint: blocking_query === null ? null : queryFingerprint(diagnosticSql(blocking_query)),
          })),
        });
      }
      throw error;
    } finally {
      this.#watches.delete(watch);
      // Other statements finishing can expose a wait that began later in SQL.
      void this.#sample();
    }
  }

  async #sample(): Promise<void> {
    if (this.#probing || !this.#watches.size || Date.now() - this.#lastProbeAt < 100) return;
    const watches = [...this.#watches];
    this.#lastProbeAt = Date.now();
    this.#probing = true;
    try {
      const { rows } = await this.observer.query<Blocker>(`
        SELECT waiting.pid waiting_pid,holder.pid blocking_pid,
          holder.query blocking_query,holder.query_id::text blocking_query_id,
          holder.state blocking_state,
          (extract(epoch FROM clock_timestamp()-holder.xact_start)*1000)::float8 transaction_age_ms
        FROM pg_stat_activity waiting
        CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) blocker(pid)
        JOIN pg_stat_activity holder ON holder.pid=blocker.pid
        WHERE waiting.pid=ANY($1::int[])`, [[...new Set(watches.map(watch => watch.pid))]]);
      for (const watch of watches) {
        watch.sampled = true;
        const blockers = rows.filter(row => row.waiting_pid === watch.pid);
        // Retain the last positive observation even if the next probe races cancellation.
        if (blockers.length) { watch.blockers = blockers; watch.observedAt = Date.now(); }
      }
    } catch {
      for (const watch of watches) watch.failed = true;
    } finally {
      this.#probing = false;
    }
  }
}
