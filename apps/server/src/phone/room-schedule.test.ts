import { describe, expect, it } from 'vitest';
import { roomSchedule } from './read-projection.js';
import type { RoomScheduleRow } from './types.js';

const at = (value: string) => new Date(value);
const row: RoomScheduleRow = {
  id: 'daily', workspace_id: 'workspace', room_id: 'room', agent_id: 'agent', creator_id: 'person',
  paused_at: null, title: 'Nightly release', max_runs: null, workflow_slug: null,
  cadence: { kind: 'cron', expression: '0 2 * * *', timeZone: 'America/New_York' },
  message: 'Release', next_run_at: at('2026-11-13T07:00:00Z'), created_at: at('2026-01-01T00:00:00Z'), run_count: 3,
};
const now = at('2026-11-14T00:01:00Z'); // Nov 13, 7:01 PM EST, as reported.
const next = (input: RoomScheduleRow, time = now) => roomSchedule(input, time).nextRunAt;

describe('routine next run projection', () => {
  it('shows the next future daily occurrence, leaving the dispatch cursor intact', () => {
    expect(next(row)).toBe(at('2026-11-14T07:00:00Z').getTime() / 1000);
    expect(row.next_run_at.toISOString()).toBe('2026-11-13T07:00:00.000Z');
    expect(next(row, row.next_run_at)).toBe(at('2026-11-14T07:00:00Z').getTime() / 1000);
  });
  it('preserves future dates and interval phase after several missed runs', () => {
    const interval = { ...row, cadence: { kind: 'interval' as const, everyMinutes: 60 }, next_run_at: at('2026-11-13T07:15:00Z') };
    expect(next(interval)).toBe(at('2026-11-14T00:15:00Z').getTime() / 1000);
    expect(next({ ...row, next_run_at: at('2026-11-15T07:00:00Z') })).toBe(at('2026-11-15T07:00:00Z').getTime() / 1000);
  });
  it('uses the declared timezone across daylight saving changes', () => {
    const dst = { ...row, next_run_at: at('2026-03-07T07:00:00Z') };
    expect(next(dst, at('2026-03-08T12:00:00Z'))).toBe(at('2026-03-09T06:00:00Z').getTime() / 1000);
  });
  it('keeps paused and one-shot due times rather than inventing another run', () => {
    const due = row.next_run_at.getTime() / 1000;
    expect(next({ ...row, paused_at: now })).toBe(due);
    expect(next({ ...row, max_runs: 1 })).toBe(due);
  });
});
