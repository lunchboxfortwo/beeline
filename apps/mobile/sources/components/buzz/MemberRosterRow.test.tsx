import { describe, expect, it, vi } from 'vitest';
vi.mock('@/ui/grammar', () => ({ T: 'Text' }));
vi.mock('./IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow' }));
import { memberRosterUsage } from './MemberRosterRow';

describe('roster subscription allowance', () => {
  it('shows remaining percentages for each low window', () => {
    expect(memberRosterUsage({ updatedAt: 1, windows: [
      { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.8, updatedAt: 1 },
      { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.926, updatedAt: 1 },
    ] })).toEqual({ text: '5h 20% left · week 7% left', tone: 'warning' });
  });
  it('keeps healthy windows quiet and rejected windows stopped', () => {
    expect(memberRosterUsage({ updatedAt: 1, windows: [
      { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.17, updatedAt: 1 },
    ] })).toBeUndefined();
    expect(memberRosterUsage({ updatedAt: 1, windows: [
      { rateLimitType: 'five_hour', status: 'rejected', utilization: 1, updatedAt: 1 },
    ] })).toEqual({ text: 'limit reached', tone: 'danger' });
  });
});
