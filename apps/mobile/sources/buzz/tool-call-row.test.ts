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
  toolCallRowModel,
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

  it('carries the search pattern in the subject and exact hit count in the right stat column', () => {
    const model = toolCallRowModel(
      step({
        id: 's',
        toolKind: 'search',
        title: 'Grep',
        input: '{"pattern":"toolCallRow","path":"sources"}',
        output: '12 matches across 3 files',
      }),
    );
    expect(model.label).toBe('toolCallRow');
    expect(model.stat).toEqual({ kind: 'text', text: '12 hits' });

    // Never fabricates/displays hit counts on truncated excerpts
    const truncatedModel = toolCallRowModel(
      step({
        id: 's2',
        toolKind: 'search',
        title: 'Grep',
        input: '{"pattern":"toolCallRow"}',
        output: '12 matches across 3 files',
        outputTruncated: true,
      }),
    );
    expect(truncatedModel.stat).toBeUndefined();
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

  it('preserves full readable commands for 2-line wrapping instead of 40-char middle-truncation soup', () => {
    const cmd = 'npm run test --workspace apps/mobile -- --coverage --reporter=json';
    const label = toolCallLabel(
      step({
        id: 't',
        toolKind: 'execute',
        command: cmd,
        title: 'Bash',
      }),
    );
    expect(label).toBe(cmd);
    expect(label).not.toContain('…');
  });

  it('prefers specific summary over unreadable inline scripts, formats distinct file line ranges, and keeps exact stats only', () => {
    const scriptModel = toolCallRowModel(
      step({
        id: 'py',
        toolKind: 'execute',
        command: `python3 -c 'import json; print([j["status"] for j in json.load(open("run.json"))])'`,
        summary: 'Inspect release run job statuses for run 45925038255',
        title: 'Bash',
      }),
    );
    expect(scriptModel.label).toBe('Inspect release run job statuses for run 45925038255');
    expect(scriptModel.replacedCommandBySummary).toBe(true);
    expect(scriptModel.subjectMono).toBe(false);

    const rangeModel = toolCallRowModel(
      step({
        id: 'loc',
        toolKind: 'read',
        title: 'Read',
        files: [
          { path: 'ui/screens/chats/ChatTree.tsx', line: 114, endLine: 145 },
          { path: 'ui/screens/chats/ChatTree.tsx', line: 200 },
        ],
      }),
    );
    expect(rangeModel.label).toBe('ChatTree.tsx:114–145, :200');
    expect(rangeModel.subjectMono).toBe(true);

    const exactDiff = toolCallRowModel(
      step({
        id: 'ed1',
        toolKind: 'edit',
        title: 'Edit',
        files: [{ path: 'ChatTree.tsx', status: 'M', addedLines: 6, removedLines: 3, diff: '+a' }],
      }),
    );
    expect(exactDiff.stat).toEqual({ kind: 'diff', added: 6, removed: 3 });

    const boundedDiff = toolCallRowModel(
      step({
        id: 'ed2',
        toolKind: 'edit',
        title: 'Edit',
        files: [{ path: 'ChatTree.tsx', status: 'M', diffTruncated: true, addedLines: 6, removedLines: 3, diff: '+a' }],
      }),
    );
    expect(boundedDiff.stat).toBeUndefined();
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

describe('beeline-agent structured receipts and output', () => {
  it('surfaces structured post-condition receipt directly on completed beeline-agent steps without prose regexes', () => {
    const updated = step({
      id: 'wake-upd',
      toolKind: 'other',
      title: 'mcp.beeline-agent.wake',
      status: 'completed',
      input: JSON.stringify({ action: 'update', trigger: 'schedule', scheduleId: 's1' }),
      output: JSON.stringify({
        scheduleId: 's1',
        receipt: 'Updated "Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo',
        repliesTo: { identityId: 'u1', handle: 'lunchboxfortwo' },
      }),
    });
    expect(toolCallVerb(updated)).toBe('updated');
    expect(toolCallLabel(updated)).toBe(
      '"Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo',
    );
    const output = toolCallOutput(updated.output);
    expect(output.length).toBeGreaterThan(0);
    expect(output.join('\n')).toContain('"scheduleId": "s1"');
    expect(output.join('\n')).toContain('"repliesTo"');

    const held = step({
      id: 'hold-set',
      toolKind: 'other',
      title: 'mcp.beeline-agent.set_thread_hold',
      status: 'completed',
      input: JSON.stringify({ address: 'c1', sourceMessageId: 'm1' }),
      output: JSON.stringify({
        holdId: 'h1',
        approvedBy: { identityId: 'u1', name: 'lunchboxfortwo', sourceMessageId: 'm1' },
        receipt: 'Set merge hold on "mcp-state-receipts" · approved by @lunchboxfortwo',
      }),
    });
    expect(toolCallVerb(held)).toBe('set');
    expect(toolCallLabel(held)).toBe('merge hold on "mcp-state-receipts" · approved by @lunchboxfortwo');
  });

  it('summarizes wake(list) structured JSON schedules and omits terminal-only envelopes from output', () => {
    const listed = step({
      id: 'wake-list-2',
      toolKind: 'other',
      title: 'mcp.beeline-agent.wake',
      status: 'completed',
      input: JSON.stringify({ action: 'list' }),
      output: JSON.stringify({
        schedules: [
          { scheduleId: 's1', title: 'Morning card', repliesTo: { handle: 'lunchboxfortwo' } },
          { scheduleId: 's2', title: 'Nightly audit', repliesTo: { handle: 'carbon' } },
        ],
      }),
    });
    expect(toolCallVerb(listed)).toBe('listed');
    expect(toolCallLabel(listed)).toBe('schedules · Morning card (replies to @lunchboxfortwo) +1 more');
    expect(toolCallOutput(listed.output).join('\n')).toContain('"Morning card"');

    const terminalOnly = step({
      id: 'term-only',
      toolKind: 'execute',
      title: 'exec_command',
      status: 'completed',
      output: JSON.stringify([{ type: 'terminal', terminalId: 't1' }]),
    });
    expect(toolCallOutput(terminalOnly.output)).toEqual([]);
  });

  it('resolves agentId@placeId, pubkeys, and thread UUIDs without ever showing raw hex/UUIDs', () => {
    const agentHex = '784c9656dbf5b4ca97f1ffc471981766a88e86ae2c965df213c6bbe1421146f4';
    const threadUuid = 'b71a2a24-3d77-4b74-abb9-d6584d6fa119';
    const lookup = {
      participants: [{ pubkey: agentHex, handle: 'crayon', name: 'Crayon' }],
      channelIndex: {
        rooms: [{ channelId: '11111111-1111-4111-8111-111111111111', name: 'beeline' }],
        corners: [
          {
            channelId: threadUuid,
            parentChannelId: '11111111-1111-4111-8111-111111111111',
            name: 'helper-index-flake',
            roomName: 'beeline',
          },
        ],
      },
      speakerName: 'Ruby',
    };
    const msgStep = step({
      id: 'handoff',
      toolKind: 'other',
      title: 'mcp__beeline-agent__message',
      input: JSON.stringify({
        type: 'normal',
        address: `${agentHex}@${threadUuid}`,
        text: 'Please push after adding tests.',
      }),
    });
    expect(toolCallVerb(msgStep, lookup)).toBe('sent');
    expect(toolCallLabel(msgStep, lookup)).toBe('message to @crayon in #helper-index-flake');
    // Without lookup, falls back to plain nouns, never raw hex/UUIDs
    const unresolved = toolCallLabel(msgStep);
    expect(unresolved).toBe('message to agent');
    expect(unresolved).not.toContain('784c96');
    expect(unresolved).not.toContain('b71a2a24');
  });

  it('maps ToolSearch, TodoWrite/plan, humanized app_tool, and cleans markdown fences/OSC/CR', () => {
    const toolSearch = step({
      id: 'ts',
      title: 'ToolSearch',
      input: JSON.stringify({ query: 'wake' }),
    });
    expect(toolCallVerb(toolSearch)).toBe('loaded');
    expect(toolCallLabel(toolSearch)).toBe('tools · wake');

    const planStep = step({
      id: 'pl',
      title: 'TodoWrite',
      plan: {
        items: [
          { step: 'Fix guard', status: 'completed' },
          { step: 'Render sheet', status: 'in_progress' },
        ],
      },
    });
    expect(toolCallVerb(planStep)).toBe('updated');
    expect(toolCallLabel(planStep)).toBe('plan · 1/2 done');

    const squireLookup = step({
      id: 'sq',
      title: 'mcp.beeline-agent.app_tool',
      input: JSON.stringify({ app: 'registry-mcp:squire', query: 'operate_drive' }),
    });
    expect(toolCallVerb(squireLookup)).toBe('searched');
    expect(toolCallLabel(squireLookup)).toBe('Trusty Squire tools');

    const fenced = '```console\n\u001b]8;;https://example.com\u0007{"date":"2026-11-25","status":"ok"}\u001b]8;;\u0007\n```';
    expect(toolCallOutput(fenced).join('\n')).toContain('"date": "2026-11-25"');
    expect(toolCallOutput('loading 10%\rloading 50%\rDone!').join('\n')).toBe('Done!');
  });
});
