import { describe, expect, it } from 'vitest';
import type { TurnActivityAction } from './activity-timeline';
import {
  displayFilePath,
  isReadOnlyShellCommand,
  peelShellCommand,
} from './tool-call-classify';
import {
  formatToolCallDuration,
  middleTruncate,
  toolCallLabel,
  toolCallOutput,
  toolCallVerb,
  TOOL_CALL_OBJECT_MAX,
} from './tool-call-row';

const step = (patch: Partial<TurnActivityAction> & { id: string }): TurnActivityAction => ({
  kind: 'tool',
  weight: 'command',
  title: 'Tool',
  label: 'tool',
  outcome: 'success',
  ...patch,
});

describe('middleTruncate', () => {
  it('keeps the head and the tail — the flags at the end carry the meaning', () => {
    const command = 'npm run test --workspace apps/mobile -- --coverage --reporter=json';
    const shown = middleTruncate(command);
    expect(shown.length).toBeLessThanOrEqual(TOOL_CALL_OBJECT_MAX);
    expect(shown).toContain('…');
    expect(command.startsWith(shown.split('…')[0]!)).toBe(true);
    expect(command.endsWith(shown.split('…')[1]!)).toBe(true);
    expect(shown).toContain('--reporter=json');
  });

  it('leaves a short command whole', () => {
    expect(middleTruncate('npm test')).toBe('npm test');
  });
});

describe('toolCallOutput', () => {
  it('renders nothing when all we were handed is a transport envelope', () => {
    expect(toolCallOutput('[{"type":"terminal","terminalId":"exec-994c47ee-1f2a"}]')).toEqual([]);
  });

  it('lifts the real text out of a content envelope', () => {
    expect(
      toolCallOutput(
        '[{"type":"content","content":{"type":"text","text":"12 passed\\n1 skipped"}}]',
      ),
    ).toEqual(['12 passed', '1 skipped']);
  });

  it('preserves internal blank lines while removing ANSI', () => {
    expect(toolCallOutput('first line\n\n\u001b[31mred line\u001b[0m')).toEqual([
      'first line',
      '',
      'red line',
    ]);
  });

  it('keeps leading indentation and blank lines in the displayed output', () => {
    expect(toolCallOutput('\n  indented\n')).toEqual(['', '  indented', '']);
  });

  it('recovers escaped newlines from a legacy JSON row cut mid-string', () => {
    expect(toolCallOutput('{"formatted_output":"first\\n\\nsecond\\nthird')).toEqual([
      'first',
      '',
      'second',
      'third',
    ]);
  });
});

describe('formatToolCallDuration', () => {
  it('says nothing below a second', () => {
    expect(formatToolCallDuration(940)).toBeUndefined();
    expect(formatToolCallDuration(undefined)).toBeUndefined();
  });

  it('reads in seconds, then minutes', () => {
    expect(formatToolCallDuration(1400)).toBe('1.4s');
    expect(formatToolCallDuration(125_000)).toBe('2m 05s');
  });
});

describe('toolCallLabel', () => {
  it('a shell call is the command itself — the glyph carries the family', () => {
    expect(
      toolCallLabel(step({ id: 'a', toolKind: 'execute', command: 'npm test', title: 'Bash' })),
    ).toBe('npm test');
  });

  it('keeps only the subcommand for git', () => {
    expect(
      toolCallLabel(
        step({ id: 'g', toolKind: 'execute', command: 'git status --short', title: 'Bash' }),
      ),
    ).toBe('status --short');
  });

  it('prefers the command over the harness title, which describes another call', () => {
    expect(
      toolCallLabel(
        step({
          id: 'l',
          toolKind: 'execute',
          command: 'ls -la sources',
          title: 'Reviewed the current changes',
        }),
      ),
    ).toBe('ls -la sources');
  });

  it('names a read by its basename', () => {
    expect(
      toolCallLabel(
        step({
          id: 'r',
          toolKind: 'read',
          title: 'Read',
          files: [{ path: 'apps/mobile/Ledger.tsx' }],
        }),
      ),
    ).toBe('Ledger.tsx');
  });

  it('names a write by its basename', () => {
    expect(
      toolCallLabel(
        step({
          id: 'w',
          toolKind: 'edit',
          title: 'Edit files',
          files: [{ path: 'sources/buzz/tool-call-row.ts' }],
        }),
      ),
    ).toBe('tool-call-row.ts');
  });

  it('carries the search pattern and the tool’s own hit count', () => {
    expect(
      toolCallLabel(
        step({
          id: 's',
          toolKind: 'search',
          title: 'Grep',
          input: '{"pattern":"toolCallRow","path":"sources"}',
          output: '12 matches across 3 files',
        }),
      ),
    ).toBe('toolCallRow · 12 hits');
  });

  it('leads an MCP call with the tool’s own short name — a verb that IS information stays', () => {
    expect(
      toolCallLabel(step({ id: 'm', toolKind: 'other', title: 'mcp__squire__list_credentials' })),
    ).toBe('list_credentials squire');
  });

  it('reads an older transcript’s folded rollup row as the calls it counts', () => {
    expect(toolCallLabel(step({ id: 'sum', toolKind: 'read', title: 'reading 8' }))).toBe(
      '8 calls',
    );
  });

  it('truncates in the middle at the label cap — the tail flags carry the meaning', () => {
    const label = toolCallLabel(
      step({
        id: 't',
        toolKind: 'execute',
        command: 'npm run test --workspace apps/mobile -- --coverage --reporter=json',
        title: 'Bash',
      }),
    );
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label).toContain('…');
    expect(label).toContain('--reporter=json');
  });

  it('keeps parent directory context for generic filenames', () => {
    expect(displayFilePath('/home/user/skills/waiting-and-wakes/SKILL.md')).toBe(
      'waiting-and-wakes/SKILL.md',
    );
    expect(displayFilePath('apps/server/index.ts')).toBe('server/index.ts');
    expect(displayFilePath('apps/server/src/index.ts')).toBe('server/src/index.ts');
    expect(displayFilePath('apps/mobile/Ledger.tsx')).toBe('Ledger.tsx');
  });

  it('formats Beeline MCP calls cleanly across harness dialects without raw mcp prefixes', () => {
    const listWake = step({
      id: 'w1',
      toolKind: 'other',
      title: 'mcp.beeline-agent.wake',
      input: JSON.stringify({ action: 'list' }),
    });
    expect(toolCallVerb(listWake)).toBe('listed');
    expect(toolCallLabel(listWake)).toBe('schedules');

    const updateWake = step({
      id: 'w2',
      toolKind: 'other',
      title: 'mcp__beeline-agent__wake',
      input: JSON.stringify({ action: 'update', title: 'Morning card' }),
    });
    expect(toolCallVerb(updateWake)).toBe('updated');
    expect(toolCallLabel(updateWake)).toBe('schedule · Morning card');

    const readMessages = step({
      id: 'r1',
      toolKind: 'other',
      title: 'mcp_beeline-agent_read',
      input: JSON.stringify({ facet: 'messages' }),
    });
    expect(toolCallVerb(readMessages)).toBe('read');
    expect(toolCallLabel(readMessages)).toBe('chat messages');

    const grokSummary = step({
      id: 'g1',
      toolKind: 'other',
      title: 'use_tool',
      input: JSON.stringify({
        tool_name: 'beeline-agent__wake',
        tool_input: { toolSummary: 'List active schedules' },
      }),
    });
    expect(toolCallVerb(grokSummary)).toBe('listed');
    expect(toolCallLabel(grokSummary)).toBe('active schedules');
  });
});

describe('shell wrapper peeling and read-only classification', () => {
  it('unwraps env, bash -lc, and leading cd wrappers while preserving multiline commands', () => {
    expect(peelShellCommand(`env CI=1 bash -lc 'cd /repo && rg -n "wake" apps/server/src'`)).toBe(
      'rg -n "wake" apps/server/src',
    );
    expect(peelShellCommand(`bash -lc 'ls\nmkdir scratch'`)).toBe('ls\nmkdir scratch');
  });

  it('keeps multiline commands distinct on the one-line ledger label', () => {
    expect(
      toolCallLabel(
        step({
          id: 'multi',
          toolKind: 'execute',
          command: 'ls\nmkdir scratch',
          title: 'exec_command',
        }),
      ),
    ).toBe('ls; mkdir scratch');
  });

  it.each([
    `rg -n "schedule" apps/server/src`,
    `env FOO=bar bash -lc 'cd /repo && rg -n "wake" apps/ | head -n 20'`,
    `cat apps/mobile/sources/buzz/tool-ledger.ts`,
    `sed -n '1,40p' apps/body/src/room-turn-steps.ts`,
    `git status --short`,
    `git -C /repo diff --stat 2>/dev/null`,
    `git log -n 5 --oneline`,
    `git show HEAD:package.json`,
    `find apps/mobile -name '*.test.ts'`,
    `ls\nrg -n "wake" apps/server/src`,
  ])('classifies strictly read-only command as observational: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  it.each([
    `rg foo && rm bar`,
    `rg --pre=sh foo apps/`,
    `git diff > out.patch`,
    `git diff --output=out.patch`,
    `git diff --output out.patch`,
    `git log --output=history.txt`,
    `git show --output=show.txt HEAD`,
    `git diff --ext-diff`,
    `git -c diff.external=sh diff`,
    `git status >> log.txt`,
    `sed -i 's/a/b/' file.ts`,
    `find . -name '*.tmp' -delete`,
    `find . -exec rm {} \\;`,
    `rg $(rm -rf /tmp/x) apps/`,
    `cat foo | tee out.txt`,
    `npm test`,
    `git commit -m "fix"`,
    `git branch -D old-branch`,
    `ls\nmkdir scratch`,
    `bash -lc 'ls\nmkdir scratch'`,
  ])('never classifies mutating or redirecting command as read-only: %s', (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });
});
