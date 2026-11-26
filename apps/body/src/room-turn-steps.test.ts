import { describe, expect, it } from 'vitest';
import type { AgentTurnStep } from './acp.js';
import { MAX_NOTE_LENGTH, MAX_REPLY_STEPS, roomReplySteps } from './room-turn-steps.js';

const note = (text: string): AgentTurnStep => ({ kind: 'note', text });
const tool = (title: string): AgentTurnStep => ({
  kind: 'tool',
  call: { id: title, title, kind: 'other', status: 'completed' },
});
const noteText = (rows: ReturnType<typeof roomReplySteps>) =>
  rows.filter((row) => row.kind === 'note').map((row) => row.text).join('');

describe('roomReplySteps', () => {
  it('saves redacted head-plus-tail output within a UTF-8 byte cap with an omission marker', () => {
    const step: AgentTurnStep = { kind: 'tool', call: {
      title: 'exec_command', content: [{ type: 'text', text: 'token=planted-secret\n-----BEGIN PRIVATE KEY-----\nplanted-pem\n-----END PRIVATE KEY-----\n' + '😀'.repeat(2000) + '\nexit code 1: final summary' }],
    } };
    const output = roomReplySteps([step])[0]!.output!;
    expect(output).not.toContain('planted-secret');
    expect(output).not.toContain('planted-pem');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[… omitted …]');
    expect(output).toContain('exit code 1: final summary');
    expect(output).not.toContain('\ufffd');
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096);
  });

  it('preserves line breaks across multi-part tool content and skips terminal handles', () => {
    const parts = [
      { type: 'terminal', terminalId: 'exec-123' },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'content',
        content: { type: 'text', text: `line-${index + 1}` },
      })),
    ];
    const output = roomReplySteps([{ kind: 'tool', call: { title: 'exec_command', content: parts } }])[0]!.output!;
    expect(output).toBe(Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n'));
  });

  it('extracts redacted command, bounded input, files, and normalizes MCP dialects', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          id: 'c1',
          kind: 'execute',
          title: 'exec_command',
          rawInput: { cmd: 'API_KEY=planted-secret rg -n wake apps/server/src' },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'c2',
          kind: 'other',
          title: 'mcp.beeline-agent.wake',
          rawInput: {
            server: 'beeline-agent',
            tool: 'wake',
            arguments: { action: 'update', title: 'Morning card', toolSummary: 'Update schedule' },
          },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'c3',
          kind: 'other',
          title: 'use_tool',
          rawInput: {
            tool_name: 'beeline-agent__read',
            tool_input: { facet: 'messages', toolSummary: 'Read chat messages' },
          },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'c4',
          kind: 'other',
          name: 'mcp_beeline-agent_wake',
          title: 'wake',
          rawInput: { action: 'list' },
        },
      },
      {
        kind: 'tool',
        call: {
          id: 'c5',
          kind: 'read',
          title: 'Read',
          locations: [{ path: '/repo/skills/waiting-and-wakes/SKILL.md' }],
          rawInput: { path: '/repo/skills/waiting-and-wakes/SKILL.md' },
        },
      },
    ]);

    expect(rows[0]!.command).toContain('[REDACTED]');
    expect(rows[0]!.command).toContain('rg -n wake apps/server/src');
    expect(JSON.stringify(rows[0])).not.toContain('planted-secret');

    expect(rows[1]).toMatchObject({
      title: 'mcp.beeline-agent.wake',
      input: JSON.stringify({ action: 'update', title: 'Morning card', toolSummary: 'Update schedule' }),
    });

    expect(rows[2]).toMatchObject({
      title: 'mcp.beeline-agent.read',
      input: JSON.stringify({ facet: 'messages', toolSummary: 'Read chat messages' }),
    });

    expect(rows[3]).toMatchObject({
      title: 'mcp.beeline-agent.wake',
      input: JSON.stringify({ action: 'list' }),
    });

    expect(rows[4]).toMatchObject({
      files: [{ path: '/repo/skills/waiting-and-wakes/SKILL.md' }],
    });
  });

  it('preserves newlines in multiline shell commands while redacting secrets', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          id: 'multi',
          kind: 'execute',
          title: 'exec_command',
          rawInput: { cmd: 'ls\nAPI_KEY=planted-secret mkdir scratch' },
        },
      },
    ]);
    expect(rows[0]!.command).toContain('\n');
    expect(rows[0]!.command!.split('\n')[0]).toBe('ls');
    expect(rows[0]!.command!.split('\n')[1]).toContain('mkdir scratch');
    expect(rows[0]!.command).toContain('[REDACTED]');
    expect(JSON.stringify(rows[0])).not.toContain('planted-secret');
  });

  it('suppresses command, input, files, and output on credential paths', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'exec_command',
          rawInput: { cmd: 'echo planted-secret > /tmp/.env', path: '/tmp/.env' },
          locations: [{ path: '/tmp/.env' }],
          content: 'planted-secret',
        },
      },
    ]);
    expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
    expect(rows[0]!.command).toBeUndefined();
    expect(rows[0]!.input).toBeUndefined();
    expect(rows[0]!.files).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('planted-secret');
  });

  it.each([
    { title: 'squire__fetch_credential' },
    { title: 'read_credential' },
    { title: 'read_file', rawInput: { path: '/tmp/.env' } },
    { title: 'exec_command', rawInput: { cmd: 'cat /tmp/credentials.json' } },
  ])('never saves secret-returning call contents: %j', (call) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { ...call, content: 'planted-secret' } }]);
    expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
    expect(JSON.stringify(rows)).not.toContain('planted-secret');
  });

  it.each(['.netrc', '_netrc', '.pgpass', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.aws/credentials', '.env', '.envrc', '.env.local', 'id_rsa', 'id_ed25519', 'service.pem', 'service.key'])('hides synthetic credential-file reads of %s before persistence', (filename) => {
    for (const call of [
      { title: 'read_file', rawInput: { path: `/synthetic/${filename}` } },
      ...['cat', 'head', 'tail', 'less', 'sed', 'awk', 'xxd', 'cp', 'python -c'].map(command => ({ title: 'exec_command', rawInput: { cmd: `${command} /synthetic/${filename}` } })),
    ]) {
      const rows = roomReplySteps([{ kind: 'tool', call: {
        ...call,
        content: 'machine example.invalid login synthetic password planted-netrc-password',
      } }]);
      expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
      expect(JSON.stringify(rows)).not.toContain('planted-netrc-password');
    }
  });

  it('hides a synthetic sed pgpass read before persistence', () => {
    const rows = roomReplySteps([{ kind: 'tool', call: {
      title: 'exec_command', rawInput: { cmd: "sed -n '1,10p' /synthetic/.pgpass" },
      content: 'example.invalid:5432:synthetic:reader:planted-pgpass-password',
    } }]);
    expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
    expect(JSON.stringify(rows)).not.toContain('planted-pgpass-password');
  });

  it.each([
    'machine example.invalid login synthetic password planted-netrc-password',
    'machine example.invalid\nlogin synthetic\npassword\nplanted-netrc-password',
    'machine example.invalid login synthetic passwd planted-netrc-password',
    'machine example.invalid\nlogin synthetic\npasswd\nplanted-netrc-password',
  ])('redacts synthetic netrc passwords before persistence: %s', (content) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { title: 'exec_command', content } }]);
    expect(JSON.stringify(rows)).not.toContain('planted-netrc-password');
    expect(rows[0]!.output).toContain('[REDACTED]');
    expect(rows[0]!.output).toContain('machine example.invalid');
  });

  it.each(['machine example.invalid login planted-netrc-login', 'machine example.invalid\nlogin\nplanted-netrc-login'])('redacts synthetic netrc logins before persistence: %s', (content) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { title: 'exec_command', content } }]);
    expect(JSON.stringify(rows)).not.toContain('planted-netrc-login');
    expect(rows[0]!.output).toContain('[REDACTED]');
  });

  it('keeps every note whole and in order between the tools', () => {
    expect(roomReplySteps([note('First.'), tool('a'), note('Second.'), tool('b')])).toEqual([
      { kind: 'note', title: 'Note', text: 'First.' },
      expect.objectContaining({ kind: 'tool', title: 'a' }),
      { kind: 'note', title: 'Note', text: 'Second.' },
      expect.objectContaining({ kind: 'tool', title: 'b' }),
    ]);
  });

  it('splits a note longer than the bound across continuing notes, losing nothing', () => {
    const long = `Start. ${'x'.repeat(MAX_NOTE_LENGTH)} End.`;
    const rows = roomReplySteps([note(long), tool('a')]);
    expect(rows.map((row) => [row.kind, row.continues ?? false])).toEqual([
      ['note', false],
      ['note', true],
      ['tool', false],
    ]);
    expect(rows.every((row) => (row.text ?? '').length <= MAX_NOTE_LENGTH)).toBe(true);
    expect(noteText(rows)).toBe(long);
  });

  it('never splits inside a surrogate pair', () => {
    const long = `${'x'.repeat(MAX_NOTE_LENGTH - 1)}😀tail`;
    const rows = roomReplySteps([note(long)]);
    expect(rows[0]!.text).toBe('x'.repeat(MAX_NOTE_LENGTH - 1));
    expect(noteText(rows)).toBe(long);
  });

  it('folds the oldest tools, never a note, when the steps exceed the bound', () => {
    const steps = [
      note('Before the tools.'),
      ...Array.from({ length: MAX_REPLY_STEPS }, (_, index) => tool(`t${index}`)),
    ];
    const rows = roomReplySteps(steps);
    expect(rows).toHaveLength(MAX_REPLY_STEPS);
    expect(rows[0]).toEqual({ kind: 'note', title: 'Note', text: 'Before the tools.' });
    expect(rows[1]).toMatchObject({ kind: 'tool', title: '2 earlier steps' });
    expect(rows.at(-1)).toMatchObject({ kind: 'tool', title: `t${MAX_REPLY_STEPS - 1}` });
  });

  it('keeps every note even when notes alone fill the bound', () => {
    const notes = Array.from({ length: MAX_REPLY_STEPS + 1 }, (_, index) => note(`n${index}`));
    const rows = roomReplySteps([...notes, tool('a')]);
    expect(rows.filter((row) => row.kind === 'note')).toHaveLength(MAX_REPLY_STEPS + 1);
    expect(rows.filter((row) => row.kind === 'tool')).toHaveLength(0);
  });

  it('preserves structured JSON receipt objects in tool output while ignoring terminal-only envelopes', () => {
    const receiptPayload = {
      scheduleId: 'sched-1',
      nextRunAt: 1_780_000_000_000,
      repliesTo: { identityId: 'u1', handle: 'lunchboxfortwo', name: 'Lunchbox' },
      approvedBy: { identityId: 'u1', handle: 'lunchboxfortwo', sourceMessageId: 'm1' },
      receipt: 'Updated "Morning card" · next run Thu (9:00 a.m. ET) · replies to @lunchboxfortwo',
    };
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'mcp.beeline-agent.wake',
          rawOutput: receiptPayload,
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'exec_command',
          content: [{ type: 'terminal', terminalId: 'term-1' }],
        },
      },
    ]);
    expect(JSON.parse(rows[0]!.output!)).toEqual(receiptPayload);
    expect(rows[1]!.output).toBeUndefined();
  });

  it('preserves app_tool metadata, message text, list_credentials metadata, and subagent fields', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'mcp.beeline-agent.app_tool',
          rawInput: {
            app: 'registry-mcp:squire',
            query: 'operate_drive operate_finish use_credential',
            tool: 'operate_drive',
            args: { url: 'https://ads.x.com/campaigns?tab=campaigns', goal: 'Read spend' },
          },
          rawOutput: { tools: [] },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'mcp.beeline-agent.message',
          rawInput: {
            type: 'normal',
            address: `${'7'.repeat(64)}@b71a2a24-3d77-4b74-abb9-d6584d6fa119`,
            text: 'Write the read-only snapshot to its own file before pushing.',
            quoteMsgId: 'msg-1',
          },
          rawOutput: { queued: true },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'mcp__squire__list_credentials',
          rawInput: {},
          rawOutput: { credentials: [{ label: 'X Ads' }] },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'invoke_subagent',
          rawInput: { Role: 'Codebase Researcher', TypeName: 'research', Prompt: 'Audit ACP' },
        },
      },
    ]);

    const appInput = JSON.parse(rows[0]!.input!);
    expect(appInput).toMatchObject({
      app: 'registry-mcp:squire',
      tool: 'operate_drive',
      query: 'operate_drive operate_finish use_credential',
      args: { url: 'https://ads.x.com/campaigns?tab=campaigns', goal: 'Read spend' },
    });

    const msgInput = JSON.parse(rows[1]!.input!);
    expect(msgInput.text).toBe('Write the read-only snapshot to its own file before pushing.');
    expect(msgInput.quoteMsgId).toBe('msg-1');

    expect(rows[2]!.output).not.toBe('Output hidden: contains a secret.');
    expect(rows[2]!.output).toContain('X Ads');

    expect(JSON.parse(rows[3]!.input!)).toMatchObject({
      Role: 'Codebase Researcher',
      TypeName: 'research',
      Prompt: 'Audit ACP',
    });
  });

  it('extracts bounded diffs from ACP diff blocks, Edit, MultiEdit, edit_file, and apply_patch', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'Edit',
          kind: 'edit',
          content: [
            {
              type: 'diff',
              path: 'apps/body/src/room-turn-steps.ts',
              oldText: "  'state',\n];",
              newText: "  'state',\n  'app',\n];",
            },
          ],
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'Edit',
          kind: 'edit',
          rawInput: {
            file_path: 'apps/mobile/sources/a.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;',
          },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'edit_file',
          kind: 'edit',
          rawInput: {
            Path: 'apps/mobile/sources/b.ts',
            Target: 'oldLine()',
            Replacement: 'newLine()',
          },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'apply_patch',
          kind: 'edit',
          rawInput:
            '*** Begin Patch\n*** Update File: apps/server/src/index.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n*** End Patch',
        },
      },
    ]);

    expect(rows[0]!.files?.[0]).toMatchObject({
      path: 'apps/body/src/room-turn-steps.ts',
      status: 'M',
    });
    expect(rows[0]!.files?.[0]?.diff).toContain("+  'app',");
    expect(rows[1]!.files?.[0]?.diff).toContain('-const a = 1;\n+const a = 2;');
    expect(rows[2]!.files?.[0]?.diff).toContain('-oldLine()\n+newLine()');
    expect(rows[3]!.files?.[0]).toMatchObject({
      path: 'apps/server/src/index.ts',
      status: 'M',
    });
    expect(rows[3]!.files?.[0]?.diff).toContain('-old\n+new');
    expect(rows[3]!.command).toBeUndefined();
  });

  it('promotes rawOutput.isError and is_error to failed, summarizes media/resources without base64, and extracts TodoWrite plans', () => {
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'mcp.beeline-agent.close_thread',
          status: 'completed',
          rawOutput: { isError: true, error: 'Missing sourceMessageId citation' },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'use_tool',
          rawInput: { tool_name: 'squire__operate_drive', tool_input: {} },
          status: 'completed',
          rawOutput: { type: 'MCP', is_error: true, output: { Error: 'UnicodeError' } },
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'screenshot',
          content: [
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
            { type: 'resource', resource: { uri: 'file:///docs/spec.md', text: 'Spec preview' } },
          ],
        },
      },
      {
        kind: 'tool',
        call: {
          title: 'TodoWrite',
          rawInput: {
            todos: [
              { content: 'Fix wire guard', status: 'completed' },
              { content: 'Ship sheet', status: 'in_progress' },
            ],
          },
        },
      },
    ]);

    expect(rows[0]!.status).toBe('failed');
    expect(rows[1]!.status).toBe('failed');
    expect(rows[2]!.output).toContain('[Image · image/png]');
    expect(rows[2]!.output).toContain('[Resource · file:///docs/spec.md]');
    expect(rows[2]!.output).toContain('Spec preview');
    expect(rows[2]!.output).not.toContain('iVBORw0KGgo');
    expect(rows[3]!.plan).toEqual({
      items: [
        { step: 'Fix wire guard', status: 'completed' },
        { step: 'Ship sheet', status: 'in_progress' },
      ],
    });
  });

  it('keeps >4 KiB JSON outputs valid JSON with _omittedCount within MAX_STEP_OUTPUT_BYTES', () => {
    const schedules = Array.from({ length: 40 }, (_, index) => ({
      scheduleId: `sched-${index + 1}`,
      title: `Schedule number ${index + 1}`,
      roomName: '#beeline',
      prompt: 'Check status and report summary. '.repeat(6),
    }));
    const rows = roomReplySteps([
      {
        kind: 'tool',
        call: {
          title: 'mcp.beeline-agent.wake',
          rawInput: { action: 'list' },
          rawOutput: { schedules },
        },
      },
    ]);
    const raw = rows[0]!.output!;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(raw) as { schedules: unknown[]; _omittedCount: number };
    expect(Array.isArray(parsed.schedules)).toBe(true);
    expect(parsed.schedules.length).toBeGreaterThan(0);
    expect(parsed.schedules.length).toBeLessThan(40);
    expect(parsed._omittedCount).toBe(40 - parsed.schedules.length);
  });
});
