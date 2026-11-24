import { describe, expect, it } from 'vitest';
import { localizeReportTimes, namedTimeZone } from './report-time.js';

describe('reader report times', () => {
  const token = '2026-11-01T05:30:00Z';
  it('renders the same report on different calendar dates and distinguishes repeated hours', () => {
    expect(localizeReportTimes(token, 'America/Los_Angeles')).toContain('Oct 31, 2026');
    expect(localizeReportTimes(token, 'Asia/Tokyo')).toContain('Nov 1, 2026');
    expect(localizeReportTimes(token, 'America/New_York')).toContain('1:30:00 AM GMT-4');
    expect(localizeReportTimes('2026-11-01T06:30:00Z', 'America/New_York')).toContain(
      '1:30:00 AM GMT-5',
    );
  });
  it('preserves literals, old prose, impossible dates and unfinished tokens', () => {
    for (const text of [
      'Tomorrow at 09:30',
      token.slice(0, -1),
      '2026-02-30T12:00:00Z',
      '> ' + token,
      '    ' + token,
      '`' + token + '`',
      '```log\n' + token,
      'https://logs.test/' + token,
      '[' + token + '](./log)',
    ])
      expect(localizeReportTimes(text, 'Asia/Tokyo')).toBe(text);
    expect(localizeReportTimes('```\n' + token + '\n```\n' + token, 'Asia/Tokyo')).toMatch(
      /Z\n```\nNov/,
    );
  });
  it('requires a recognized named zone and falls back for obsolete preferences', () => {
    for (const value of [false, '+04:00', 'Bogus/Nowhere', ''])
      expect(namedTimeZone(value)).toBeUndefined();
    expect(localizeReportTimes(token, 'Bogus/Nowhere')).toBe(localizeReportTimes(token, 'UTC'));
  });
});
