import { describe, expect, it } from 'vitest';
import { buildToolSheetPresentation, parseReadableProse } from './tool-output-format';

describe('parseReadableProse', () => {
  it('formats web search summaries with separated links/citations cleanly', () => {
    const raw = [
      'Claude Code and OpenCode interleave prose and tool steps chronologically in one terminal stream, folding consecutive file reads into a single line and capping long outputs behind an expand toggle.',
      '',
      'Sources:',
      '- https://docs.anthropic.com/en/docs/claude-code',
      '- [OpenCode TUI](https://opencode.ai/docs/tui)',
    ].join('\n');

    const parsed = parseReadableProse(raw, { isWebSearch: true });
    expect(parsed).toEqual({
      paragraphs: [
        'Claude Code and OpenCode interleave prose and tool steps chronologically in one terminal stream, folding consecutive file reads into a single line and capping long outputs behind an expand toggle.',
      ],
      links: [
        {
          label: 'docs.anthropic.com/en/docs/claude-code',
          url: 'https://docs.anthropic.com/en/docs/claude-code',
        },
        {
          label: 'OpenCode TUI',
          url: 'https://opencode.ai/docs/tui',
        },
      ],
    });
  });

  it('keeps terminal logs, stack traces, and source code as mono instead of prose', () => {
    expect(
      parseReadableProse('PASS src/a.test.ts\n[… omitted …]\nKilled (signal SIGKILL)'),
    ).toBeUndefined();
    expect(
      parseReadableProse(
        '12:04:11 WARN api.usebeeline.app:443 retry 1\nC:\\Users\\dev\\beeline\\app.ts: loaded config',
      ),
    ).toBeUndefined();
    expect(
      parseReadableProse('const value = 1;\nexport function run() {\n  return value;\n}'),
    ).toBeUndefined();
    expect(parseReadableProse('tests passed')).toBeUndefined();
  });
});

describe('buildToolSheetPresentation (prose & web search)', () => {
  it('renders web search prose in Zone 1 with web search subtitle and Arguments & raw footer', () => {
    const sheet = buildToolSheetPresentation({
      title: 'Searched “Claude Code” OpenCode agent activity progress',
      searchScope: 'web',
      input: JSON.stringify({ query: '"Claude Code" OpenCode agent activity progress' }),
      detail: [
        'Claude Code and OpenCode interleave prose and tool steps chronologically in one terminal stream, folding consecutive file reads into a single line.',
        '',
        'https://docs.anthropic.com/en/docs/claude-code',
        'https://opencode.ai/docs/tui',
      ].join('\n'),
    });

    expect(sheet.subtitle).toBe('web search');
    expect(sheet.rawLabel).toBe('Arguments & raw');
    expect(sheet.zone1ShowsMonoVerbatim).toBeUndefined();
    expect(sheet.body).toEqual({
      kind: 'prose',
      paragraphs: [
        'Claude Code and OpenCode interleave prose and tool steps chronologically in one terminal stream, folding consecutive file reads into a single line.',
      ],
      links: [
        {
          label: 'docs.anthropic.com/en/docs/claude-code',
          url: 'https://docs.anthropic.com/en/docs/claude-code',
        },
        {
          label: 'opencode.ai/docs/tui',
          url: 'https://opencode.ai/docs/tui',
        },
      ],
    });
  });

  it('formats structured JSON web search summary + citations payloads as prose', () => {
    const sheet = buildToolSheetPresentation({
      title: 'Searched web',
      searchScope: 'web',
      detail: JSON.stringify({
        summary:
          'Modern coding agents summarize completed turns with concise outcome lines and fold consecutive read checks into one expandable row.',
        citations: [
          { title: 'Claude Code Docs', url: 'https://docs.anthropic.com/en/docs/claude-code' },
          'https://opencode.ai/docs/tui',
        ],
      }),
    });

    expect(sheet.body.kind).toBe('prose');
    if (sheet.body.kind === 'prose') {
      expect(sheet.body.paragraphs).toHaveLength(1);
      expect(sheet.body.links).toEqual([
        { label: 'Claude Code Docs', url: 'https://docs.anthropic.com/en/docs/claude-code' },
        { label: 'opencode.ai/docs/tui', url: 'https://opencode.ai/docs/tui' },
      ]);
    }
  });

  it('never promotes shell command output or failure output to prose', () => {
    const commandSheet = buildToolSheetPresentation({
      title: 'cat README.md',
      command: 'cat README.md',
      detail:
        'Beeline keeps chats quiet and surfaces real outcomes instead of raw step counts across phones and desktop clients.',
    });
    expect(commandSheet.body.kind).toBe('mono');

    const failedSheet = buildToolSheetPresentation({
      title: 'Searched web',
      searchScope: 'web',
      outcome: 'failure',
      detail:
        'The remote web search provider returned an upstream gateway timeout after retrying three times.',
    });
    expect(failedSheet.body.kind).toBe('mono');
  });
});
