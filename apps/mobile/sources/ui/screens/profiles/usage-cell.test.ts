import { describe, expect, it } from 'vitest';
import type { AgentUsage } from '@beeline/api-contract/phone';
import { usageCell } from './usage-cell';

const snapshot = (utilization?: number, status: AgentUsage['windows'][number]['status'] = 'allowed'): AgentUsage => ({
  updatedAt: 1,
  windows: [{ rateLimitType: 'five_hour', status, utilization, updatedAt: 1 }],
});

describe('subscription allowance left', () => {
  it.each([[0, '100%', 1, undefined], [0.17, '83%', 0.83, undefined],
    [0.794, '21%', 0.206, undefined], [0.8, '20%', 0.2, 'warning'],
    [0.926, '7%', 0.074, 'warning'], [1, '0%', 0, 'warning']])(
    'renders utilization %s as remaining', (used, value, fill, tone) => {
      const column = usageCell(snapshot(used as number), 'codex').columns[0];
      expect(column.value).toBe(`${value} left`);
      expect(column.fill).toBeCloseTo(fill as number);
      expect(column.tone).toBe(tone);
    },
  );

  it('keeps rejected windows at Limit', () => {
    expect(usageCell(snapshot(0.17, 'rejected'), 'codex').columns[0])
      .toMatchObject({ value: 'Limit', fill: 1, tone: 'danger' });
  });

  it('keeps untrusted readings muted without a warning', () => {
    const cell = usageCell(snapshot(0.92), 'codex', undefined, { status: 'no_answer' });
    expect(cell.muted).toBe(true);
    expect(cell.columns[0]).toMatchObject({ value: '8% left', tone: undefined });
  });

  it('keeps each window, credits, and shared reset information', () => {
    const cell = usageCell({ updatedAt: 1, windows: [
      { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.17, resetsAt: 100, updatedAt: 1 },
      { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.926, resetsAt: 100, updatedAt: 1 },
    ], credits: { remaining: 12 } }, 'codex');
    expect(cell.columns.map(c => c.value)).toEqual(['83% left', '7% left', '12 left']);
    expect(cell.columns.every(c => !c.foot)).toBe(true);
    expect(cell.stamp).toContain('resets');
  });
});
