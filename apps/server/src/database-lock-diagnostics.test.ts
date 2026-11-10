import { expect, it, vi } from 'vitest';
import { DatabaseLockDiagnostics, diagnosticSql } from './database-lock-diagnostics.js';
import type { SqlDatabase } from './database.js';

it.each([
  ["SELECT 'body', E'escaped\\\'secret', 123, $2 -- secret\nFROM messages", 'SELECT ?, E?, ?, ? FROM messages'],
  ['SELECT $$body$$, $tag$secret$tag$, "private identifier" /* secret /* nested */ tail */ FROM messages', 'SELECT ?, ?, ? FROM messages'],
  ["SELECT 'truncated secret", 'SELECT ?'],
  ['SELECT $tag$truncated secret', 'SELECT ?'],
  ['SELECT 1 /* truncated secret', 'SELECT ?'],
  [String.raw`SELECT 'ends-with-backslash\', 'private-message-secret'`, '[SQL redacted]'],
  [String.raw`SELECT E'escaped\'private-message-secret', 'tail'`, 'SELECT E?, ?'],
  [String.raw`SELECT "ends-with-backslash\", 'private-message-secret'`, 'SELECT ?, ?'],
  ['SELECT "doubled""private", \'doubled\'\'secret\'', 'SELECT ?, ?'],
])('redacts SQL values and comments before logging: %s', (sql, expected) => {
  expect(diagnosticSql(sql)).toBe(expected);
});

it.each([
  String.raw`SELECT 'ends-with-backslash\', 'private-message-secret'`,
  String.raw`SELECT E'escaped\'private-message-secret'`,
  String.raw`SELECT "ends-with-backslash\", 'private-message-secret'`,
  "SELECT 'truncated-private-message-secret",
])('redacts waiting and blocking SQL in the timeout log: %s', async sql => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const observer = { query: vi.fn().mockResolvedValue({ rows: [{
    waiting_pid: 42, blocking_pid: 43, blocking_query: sql,
    blocking_query_id: '1', blocking_state: 'idle in transaction', transaction_age_ms: 100,
  }] }) } as unknown as SqlDatabase;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, no) => { reject = no; });
  try {
    const work = new DatabaseLockDiagnostics(observer).statement(42, sql, () => pending);
    const failed = expect(work).rejects.toMatchObject({ code: '55P03' });
    await Promise.resolve(); await Promise.resolve();
    reject(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    await failed;
    expect(warn).toHaveBeenCalledWith('[database] lock timeout', expect.objectContaining({
      statement: diagnosticSql(sql), observation: 'captured',
      blockers: [expect.objectContaining({ query: diagnosticSql(sql) })],
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-message-secret');
  } finally { warn.mockRestore(); }
});

it('does not queue another probe behind an unavailable observer or delay the failed query', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, no) => { reject = no; });
  const query = vi.fn().mockReturnValue(new Promise(() => {}));
  const observer = { query } as unknown as SqlDatabase;
  try {
    const diagnostics = new DatabaseLockDiagnostics(observer);
    const work = diagnostics.statement(42, 'SELECT 1', () => pending);
    const failed = expect(work).rejects.toMatchObject({ code: '55P03' });
    vi.advanceTimersByTime(1000);
    expect(query).toHaveBeenCalledOnce();
    reject(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    await failed;
    expect(warn).toHaveBeenCalledWith('[database] lock timeout', expect.objectContaining({
      observation: 'not-sampled', blockers: [],
    }));
    expect(vi.getTimerCount()).toBe(0);
  } finally { warn.mockRestore(); vi.useRealTimers(); }
});

it.each([undefined, 42])('reports unavailable observation without leaking or replacing the timeout (pid=%s)', async pid => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const observer = { query: vi.fn().mockRejectedValue(new Error('private connection secret')) } as unknown as SqlDatabase;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, no) => { reject = no; });
  try {
    const diagnostics = new DatabaseLockDiagnostics(observer);
    const error = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const work = diagnostics.statement(pid, "SELECT 'private body'", () => pending);
    const failed = expect(work).rejects.toBe(error);
    vi.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve();
    reject(error); await failed;
    expect(warn).toHaveBeenCalledWith('[database] lock timeout', expect.objectContaining({
      observation: 'unavailable', statement: 'SELECT ?', blockers: [],
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  } finally { warn.mockRestore(); vi.useRealTimers(); }
});
