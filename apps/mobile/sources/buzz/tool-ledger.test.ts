import { describe, expect, it } from 'vitest';
import { buildTurnActivity, type TurnActivityAction } from './activity-timeline';
import { groupToolLedgerRuns, toolGlyph, toolGroupSummary, toolLedgerLines } from './tool-ledger';

const step = (patch: Partial<TurnActivityAction> & { id: string }): TurnActivityAction => ({
  kind: 'tool',
  weight: 'command',
  title: 'Tool',
  label: 'tool',
  outcome: 'success',
  ...patch,
});

describe('toolGlyph', () => {
  it('gives shell work the two-character prompt glyph', () => {
    expect(toolGlyph({ kind: 'tool', toolKind: 'execute' })).toBe('>_');
  });

  it('gives the file family the one fold-line', () => {
    for (const verb of ['read', 'edit', 'write', 'patch', 'list', 'search', 'move', 'delete']) {
      expect(toolGlyph({ kind: 'tool', toolKind: verb })).toBe('≡');
    }
  });

  it('gives a thought the fold glyph, and everything else the quiet dot', () => {
    expect(toolGlyph({ kind: 'thought' })).toBe('⋯');
    expect(toolGlyph({ kind: 'tool', toolKind: 'fetch' })).toBe('·');
    expect(toolGlyph({ kind: 'tool', toolKind: 'mcp' })).toBe('·');
    expect(toolGlyph({ kind: 'tool' })).toBe('·');
  });
});

describe('toolLedgerLines', () => {
  it('labels a tool line with the call’s object, not the verb', () => {
    const [line] = toolLedgerLines([
      step({ id: 'a', toolKind: 'execute', command: 'npm test', title: 'Bash' }),
    ]);
    expect(line!.label).toBe('npm test');
    expect(line!.glyph).toBe('>_');
    expect(line!.outcome).toBe('success');
  });

  it('carries the distilled failure reason inline only on failures', () => {
    const [failed, passed] = toolLedgerLines([
      step({
        id: 'f',
        toolKind: 'execute',
        command: 'pnpm fast-gate',
        outcome: 'failure',
        weight: 'failure',
        reason: 'command not found: pnpm',
        output: '[{"type":"terminal","terminalId":"exec-1"}]',
        status: 'error',
      }),
      step({ id: 'p', toolKind: 'execute', command: 'pnpm fast-gate', reason: 'stale reason' }),
    ]);
    expect(failed!.reason).toBe('command not found: pnpm');
    expect(passed!.reason).toBeUndefined();
  });

  it('omits the duration gutter when no receipt carried one, and never fakes one', () => {
    const [noDuration, tooShort, shown] = toolLedgerLines([
      step({ id: 'n', toolKind: 'read', title: 'Read' }),
      step({ id: 's', toolKind: 'read', title: 'Read', durationMs: 900 }),
      step({ id: 'd', toolKind: 'read', title: 'Read', durationMs: 2100 }),
    ]);
    expect(noDuration!.durationMs).toBeUndefined();
    expect(tooShort!.durationMs).toBeUndefined();
    expect(shown!.durationMs).toBe(2100);
  });

  it('keeps failure reason and output in the sheet detail without fabricating path-only file lines', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'd',
        toolKind: 'read',
        title: 'Read',
        outcome: 'failure',
        reason: 'permission denied',
        files: [{ path: 'sources/Ledger.tsx', status: 'M' }],
        output: '[{"type":"content","content":{"type":"text","text":"first\\nsecond"}}]',
      }),
    ]);
    expect(line!.detail).toBe(['permission denied', 'first', 'second'].join('\n'));
    expect(line!.detail).not.toContain('M sources/Ledger.tsx');
  });

  it('enforces the chevron acceptance invariant across receipts, failures, old/new servers, and unseen facts', () => {
    const [pathOnlyRead, emptyReadMsg, redundantFail, extraFail, exitZeroCmd, oldServerHandle, newServerNoDetail] =
      toolLedgerLines([
        step({
          id: 'r1',
          toolKind: 'read',
          title: 'Read',
          files: [{ path: 'agent-home/codex/skills/beeline-connecting-services/SKILL.md' }],
        }),
        step({
          id: 'r2',
          toolKind: 'other',
          title: 'mcp.beeline-agent.read',
          input: '{"facet":"message","messageId":"abc"}',
        }),
        step({
          id: 'f1',
          toolKind: 'execute',
          title: 'Bash',
          command: 'vitest run',
          outcome: 'failure',
          reason: 'command not found: vitest',
        }),
        step({
          id: 'f2',
          toolKind: 'execute',
          title: 'Bash',
          command: 'vitest run',
          outcome: 'failure',
          reason: 'command not found: vitest',
          output: 'sh: 1: vitest: not found\nPATH=/usr/bin',
        }),
        step({
          id: 'ok0',
          toolKind: 'execute',
          title: 'Bash',
          command: 'git add ChatTree.tsx',
          exitCode: 0,
        }),
        step({
          id: 'old-srv',
          toolKind: 'read',
          title: 'Read',
          toolOutput: { roomId: '11111111-1111-4111-8111-111111111111', anchor: 'a', messageId: 'm' },
        }),
        step({
          id: 'new-srv',
          toolKind: 'read',
          title: 'Read',
          hasDetail: false,
          toolOutput: { roomId: '11111111-1111-4111-8111-111111111111', anchor: 'a', messageId: 'm', hasDetail: false },
        }),
      ]);

    expect(pathOnlyRead!.inspectable).toBe(false);
    expect(emptyReadMsg!.inspectable).toBe(false);
    expect(redundantFail!.inspectable).toBe(false);
    expect(extraFail!.inspectable).toBe(true);
    expect(exitZeroCmd!.inspectable).toBe(true);
    // Old server unconditional handle cannot rule out unseen detail before fetch
    expect(oldServerHandle!.inspectable).toBe(true);
    // New server explicit hasDetail=false stays quiet
    expect(newServerNoDetail!.inspectable).toBe(false);
  });

  it('a step with nothing behind it is not pressable — no detail at all', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'q',
        toolKind: 'read',
        title: 'Read',
        output: '[{"type":"terminal","terminalId":"x"}]',
      }),
    ]);
    expect(line!.detail).toBeUndefined();
  });

  it('a thought carries its text as detail; a summary-only thought stays quiet', () => {
    const [texted, quiet] = toolLedgerLines([
      step({
        id: 't',
        kind: 'thought',
        label: 'thought',
        output: 'weighing the two layouts',
        durationMs: 51_000,
      }),
      step({ id: 's', kind: 'thought', label: 'thought', durationMs: 12_000 }),
    ]);
    expect(texted!.kind).toBe('thought');
    expect(texted!.detail).toBe('weighing the two layouts');
    expect(quiet!.detail).toBeUndefined();
  });

  it('carries the grant attribution into the sheet detail', () => {
    const [line] = toolLedgerLines([
      step({
        id: 'g',
        toolKind: 'execute',
        command: 'npm test',
        requestedBy: { pubkey: 'abc123', name: 'lunchbox' },
      }),
    ]);
    expect(line!.requester).toBe("at lunchbox's request");
    expect(line!.detail).toBeUndefined();
  });

  it('the live turn’s last step reads as running; everything else settles', () => {
    const steps = [
      step({ id: 'a', toolKind: 'read', title: 'Read' }),
      step({ id: 'b', toolKind: 'execute', command: 'npm test', status: 'exit 0' }),
    ];
    const [first, last] = toolLedgerLines(steps, true);
    expect(first!.outcome).toBe('success');
    expect(last!.outcome).toBe('running');
    const [still, settled] = toolLedgerLines(steps, false);
    expect(still!.outcome).toBe('success');
    expect(settled!.outcome).toBe('success');
  });
});

describe('groupToolLedgerRuns', () => {
  const run = (ids: string[]) =>
    toolLedgerLines(ids.map((id) => step({ id, toolKind: 'read', title: 'Read' })));

  it.each([1, 2, 3])('folds a %i-step machine run into one group', (count) => {
    const ids = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
    const [group, ...rest] = groupToolLedgerRuns(run(ids));
    expect(rest).toHaveLength(0);
    expect(group).toMatchObject({ kind: 'group', id: 'a', count, failed: 0 });
    expect(group!.lines.map((line) => line.id)).toEqual(ids);
  });

  it('returns no disclosure for an empty machine run', () => {
    expect(groupToolLedgerRuns([])).toEqual([]);
  });

  it('counts failures and sums the durations the receipts carried', () => {
    const lines = toolLedgerLines([
      step({ id: 'a', toolKind: 'read', title: 'Read', durationMs: 1000 }),
      step({ id: 'b', toolKind: 'read', title: 'Read', durationMs: 2000 }),
      step({
        id: 'f',
        toolKind: 'execute',
        command: 'pnpm fast-gate',
        outcome: 'failure',
        weight: 'failure',
        reason: 'command not found: pnpm',
      }),
      step({ id: 'd', toolKind: 'read', title: 'Read', durationMs: 45_000 }),
    ]);
    const [group] = groupToolLedgerRuns(lines);
    expect(group).toMatchObject({ kind: 'group', count: 4, failed: 1, durationMs: 48_000 });
  });

  it('a group with no duration above the floor omits the gutter', () => {
    const lines = toolLedgerLines([
      step({ id: 'a', toolKind: 'read', title: 'Read', durationMs: 200 }),
      step({ id: 'b', toolKind: 'read', title: 'Read' }),
      step({ id: 'c', toolKind: 'read', title: 'Read' }),
      step({ id: 'd', toolKind: 'read', title: 'Read' }),
    ]);
    const [group] = groupToolLedgerRuns(lines);
    expect(group).toMatchObject({ kind: 'group', count: 4 });
    expect(group).not.toHaveProperty('durationMs');
  });
});

describe('notes in a run', () => {
  it('a note line is the whole text, the pencil glyph, and no verdict', () => {
    const [line] = toolLedgerLines([
      step({ id: 'n', kind: 'note', title: 'Long text', label: 'First.\n\nSecond.' }),
    ]);
    expect(line).toMatchObject({ kind: 'note', glyph: '✎', label: 'First.\n\nSecond.' });
  });

  it('counts notes apart from steps', () => {
    const [group] = groupToolLedgerRuns(
      toolLedgerLines([
        step({ id: 'n1', kind: 'note', label: 'one' }),
        step({ id: 'a', toolKind: 'read', title: 'Read' }),
        step({ id: 'n2', kind: 'note', label: 'two' }),
        step({ id: 'b', toolKind: 'read', title: 'Read' }),
      ]),
    );
    expect(group).toMatchObject({ count: 2, notes: 2, failed: 0 });
    expect(group!.lines.map((line) => line.id)).toEqual(['n1', 'a', 'n2', 'b']);
  });

  it('reads `4 steps · 2 notes · 18s`, and `1 note` with no steps', () => {
    expect(toolGroupSummary(4, 0, 18_000, 2)).toBe('4 steps · 2 notes · 18.0s');
    expect(toolGroupSummary(4, 1, undefined, 1)).toBe('4 steps · 1 failed · 1 note');
    expect(toolGroupSummary(0, 0, undefined, 1)).toBe('1 note');
  });
});

describe('toolGroupSummary', () => {
  it('reads `6 steps · 2 failed · 48s`', () => {
    expect(toolGroupSummary(6, 2, 48_000)).toBe('6 steps · 2 failed · 48.0s');
  });

  it('a clean run carries no failed segment', () => {
    expect(toolGroupSummary(6, 0, 48_000)).toBe('6 steps · 48.0s');
  });

  it('one step, and no duration below the floor', () => {
    expect(toolGroupSummary(1, 0, undefined)).toBe('1 step');
    expect(toolGroupSummary(4, 0, 500)).toBe('4 steps');
  });
});

describe('flat v3 ledger, startup warning demotion, and honest tap targets', () => {
  it('keeps every step as one flat row with zero nested observation folding or header provenance', () => {
    const turn = buildTurnActivity([
      {
        kind: 'tool',
        id: 'r1',
        title: 'Read',
        toolKind: 'read',
        files: [{ path: '/repo/skills/waiting-and-wakes/SKILL.md' }],
        status: 'completed',
      },
      {
        kind: 'tool',
        id: 's1',
        title: 'exec_command',
        toolKind: 'execute',
        command: `bash -lc 'cd /repo && rg -n wake apps/server/src'`,
        status: 'completed',
      },
      {
        kind: 'tool',
        id: 'e1',
        title: 'Edit',
        toolKind: 'edit',
        files: [{ path: 'apps/server/src/index.ts' }],
        status: 'completed',
      },
      {
        kind: 'tool',
        id: 'f1',
        title: 'exec_command',
        toolKind: 'execute',
        command: 'npm test',
        status: 'failed',
        output: 'sh: 1: vitest: not found',
      },
    ]);
    const [group] = groupToolLedgerRuns(toolLedgerLines(turn.steps));
    expect(group!.count).toBe(4);
    expect(group!.failed).toBe(1);
    expect(group!.lines).toHaveLength(4);
    expect(group).not.toHaveProperty('provenance');
    expect(group!.lines.every((line) => !('folded' in line))).toBe(true);
    expect(group!.lines[0]!.label).toBe('waiting-and-wakes/SKILL.md');
    expect(group!.lines[1]!.label).toBe('rg -n wake apps/server/src');
    expect(group!.lines[2]!.label).toBe('server/src/index.ts');
    expect(group!.lines[3]!.outcome).toBe('failure');
    expect(group!.lines[3]!.label).toBe('npm test');
  });

  it('marks note, rollup-only, and empty terminalId-only rows as non-inspectable', () => {
    const turn = buildTurnActivity([
      { kind: 'note', id: 'n1', title: 'Note', text: 'Checking schedules first.' },
      { kind: 'summary', title: 'Summary', rollup: { read: 8 } },
      { kind: 'tool', id: 'fold', title: '12 earlier steps', status: 'completed' },
      {
        kind: 'tool',
        id: 'term',
        title: 'exec_command',
        toolKind: 'execute',
        status: 'completed',
        output: '[{"type":"terminal","terminalId":"exec-123"}]',
      },
      {
        kind: 'tool',
        id: 'term-cmd',
        title: 'exec_command',
        toolKind: 'execute',
        command: 'git status',
        status: 'completed',
        output: '[{"type":"terminal","terminalId":"exec-456"}]',
      },
    ]);
    const lines = toolLedgerLines(turn.steps);
    expect(lines[0]!.inspectable).toBe(false);
    expect(lines[1]!.inspectable).toBe(false);
    expect(lines[2]!.inspectable).toBe(false);
    expect(lines[3]!.inspectable).toBe(false);
    expect(lines[4]!.inspectable).toBe(true);
    expect(lines[4]!.terminalOnly).toBe(true);
  });

  it('demotes recovered harness startup warnings to quiet notes with zero failed count', () => {
    const turn = buildTurnActivity(
      [
        {
          kind: 'tool',
          id: 'boot',
          title: 'codex-acp',
          toolKind: 'other',
          status: 'failed',
          output: '[codex-acp forwarded startup stderr] MCP server codegraph timed out during boot',
        },
        {
          kind: 'tool',
          id: 'w1',
          title: 'mcp.beeline-agent.wake',
          toolKind: 'other',
          input: JSON.stringify({ action: 'list' }),
          status: 'completed',
        },
      ],
      { settled: true },
    );
    const [group] = groupToolLedgerRuns(toolLedgerLines(turn.steps));
    expect(group!.failed).toBe(0);
    expect(group!.notes).toBe(0);
    expect(group!.count).toBe(1);
    expect(group!.lines[0]).toMatchObject({ kind: 'note', startupWarning: true, outcome: 'success' });
    expect(group).not.toHaveProperty('provenance');
  });

  it('renders legacy stored rows without command or input without mangling to "the code" or "a file"', () => {
    const turn = buildTurnActivity([
      {
        kind: 'tool',
        id: 'legacy-rg',
        title: 'rg -n "schedule" apps/server/src',
        toolKind: 'execute',
        status: 'completed',
      },
      {
        kind: 'tool',
        id: 'legacy-read',
        title: 'Read /home/lunchbox/skills/waiting-and-wakes/SKILL.md',
        toolKind: 'read',
        status: 'completed',
      },
      {
        kind: 'tool',
        id: 'legacy-mcp',
        title: 'mcp.beeline-agent.wake',
        toolKind: 'other',
        status: 'completed',
      },
    ]);
    const lines = toolLedgerLines(turn.steps);
    expect(lines[0]!.label).toBe('rg -n "schedule" apps/server/src');
    expect(lines[0]!.label).not.toContain('the code');
    expect(lines[1]!.label).toBe('waiting-and-wakes/SKILL.md');
    expect(lines[1]!.label).not.toBe('SKILL.md');
    expect(lines[2]!.verb).toBe('checked');
    expect(lines[2]!.label).toBe('schedules');
    expect(lines[2]!.label).not.toContain('mcp.beeline-agent');
  });

  it('carries structured beeline-agent receipts onto ToolLedgerLine without header provenance', () => {
    const receipt = 'Updated "Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo';
    const turn = buildTurnActivity([
      {
        kind: 'tool',
        id: 'wake-update',
        title: 'mcp.beeline-agent.wake',
        toolKind: 'other',
        status: 'completed',
        input: JSON.stringify({ action: 'update', trigger: 'schedule', scheduleId: 's1' }),
        output: JSON.stringify({ scheduleId: 's1', receipt }),
      },
      {
        kind: 'tool',
        id: 'open-thread',
        title: 'mcp.beeline-agent.open_thread',
        toolKind: 'other',
        status: 'completed',
        input: JSON.stringify({ name: 'mcp-state-receipts', implementer: 'crayon' }),
        output: JSON.stringify({
          address: 'c1',
          receipt: 'Opened thread "mcp-state-receipts" · implementer @crayon · approved by @lunchboxfortwo',
        }),
      },
    ]);
    const lines = toolLedgerLines(turn.steps);
    expect(lines[0]).toMatchObject({
      verb: 'updated',
      receipt,
      label: '"Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo',
    });
    expect(lines[1]).toMatchObject({
      verb: 'opened',
      receipt: 'Opened thread "mcp-state-receipts" · implementer @crayon · approved by @lunchboxfortwo',
    });
    const group = groupToolLedgerRuns(lines)[0]!;
    expect(group).not.toHaveProperty('provenance');
  });

  it('detects rejected, timed_out, cancelled, MCP isError, and Grok output.Error as failures', () => {
    const turn = buildTurnActivity([
      { kind: 'tool', id: 'r', title: 'Bash', status: 'rejected', output: 'Denied by owner' },
      { kind: 'tool', id: 't', title: 'Bash', status: 'timed_out', output: 'Timed out after 60s' },
      { kind: 'tool', id: 'c', title: 'Bash', status: 'cancelled' },
      {
        kind: 'tool',
        id: 'g',
        title: 'mcp.squire.operate_drive',
        status: 'completed',
        output: JSON.stringify({ is_error: true, output: { Error: 'UnicodeEncodeError on ads tab' } }),
      },
    ]);
    const lines = toolLedgerLines(turn.steps);
    expect(lines.map((l) => l.outcome)).toEqual(['failure', 'failure', 'failure', 'failure']);
    expect(lines[3]!.reason).toContain('UnicodeEncodeError on ads tab');
  });
});
