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
  it('preserves nested and escaped parentheses in relative Markdown targets', () => {
    for (const target of [
      `../reports/(archive)/${token}`,
      `../(a(b)c)/${token}`,
      `../archive\\)/${token}`,
    ]) {
      const link = `[run](${target})`;
      expect(localizeReportTimes(link + ' at ' + token, 'Asia/Tokyo')).toBe(
        link + ' at ' + localizeReportTimes(token, 'Asia/Tokyo'),
      );
    }
  });
  it.each([
    '[run](<../reports/archive(>)',
    '[run](../report "Archive (old")',
    "[run](../report 'Archive )old')",
    `[run](  <../(archive)/${token}> "Archive )")`,
    `[run](../report "Archive \\"(old\\" ${token}")`,
    `[run](../it's(a)/${token} (Archive))`,
  ])('preserves %s and localizes the prose after it', (link) => {
    expect(localizeReportTimes(`${link} at ${token}`, 'America/New_York')).toBe(
      `${link} at ${localizeReportTimes(token, 'America/New_York')}`,
    );
  });
  it.each(['~~~', '```'])('closes a %s fence only with enough matching markers', (opening) => {
    const literal = [
      opening,
      token,
      opening.slice(1),
      token,
      opening === '~~~' ? '````' : '~~~~',
      token,
      opening + opening,
    ].join('\n');
    expect(localizeReportTimes(literal + '\n' + token, 'Asia/Tokyo')).toBe(
      literal + '\n' + localizeReportTimes(token, 'Asia/Tokyo'),
    );
  });
  it('requires a recognized named zone and falls back for obsolete preferences', () => {
    for (const value of [false, '+04:00', 'Bogus/Nowhere', ''])
      expect(namedTimeZone(value)).toBeUndefined();
    expect(localizeReportTimes(token, 'Bogus/Nowhere')).toBe(localizeReportTimes(token, 'UTC'));
  });
});
