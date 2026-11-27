import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { readRoomTools } from './room-tool-projection.js';

describe('stored tool output disclosure', () => {
  it('keeps bodies out of the step list, emits conditional per-item toolOutput, and returns full detail on tap', async () => {
    const db = new PgliteDatabase();
    const viewer = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const message = 'c'.repeat(64);
    try {
      await migrate(db);
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'agent','Writer')`, [viewer, agent]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'proof')`, [room, workspace, viewer]);
      await db.query(`INSERT INTO memberships(room_id,workspace_id,identity_id,role) VALUES($1,$2,$3,'member'),(NULL,$2,$3,'member')`, [room, workspace, viewer]);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,activity) VALUES($1,$2,$3,'','activity',$4::jsonb)`,
        [message, room, agent, JSON.stringify([
          {
            kind: 'tool',
            title: 'Read',
            operation: 'read',
            status: 'completed',
            command: 'cat skills/waiting-and-wakes/SKILL.md',
            input: '{"path":"skills/waiting-and-wakes/SKILL.md"}',
            files: [{ path: 'skills/waiting-and-wakes/SKILL.md' }],
            output: 'file contents',
            requestedBy: { pubkey: viewer, name: 'Reader' },
          },
          {
            kind: 'tool',
            title: 'Legacy row',
            status: 'completed',
          },
        ])]);
      const list = await readRoomTools(db, { roomId: room, anchor: message }, viewer);
      expect(list.messages[0]!.activity![0]).not.toHaveProperty('output');
      expect(list.messages[0]!.activity![0]).toMatchObject({
        title: 'Read',
        command: 'cat skills/waiting-and-wakes/SKILL.md',
        input: '{"path":"skills/waiting-and-wakes/SKILL.md"}',
        files: [{ path: 'skills/waiting-and-wakes/SKILL.md' }],
        hasDetail: true,
        toolOutput: { roomId: room, anchor: message, messageId: message, itemIndex: 0, hasDetail: true },
      });
      // Empty legacy row has no withheld detail -> no toolOutput handle.
      expect(list.messages[0]!.activity![1]).toEqual({
        kind: 'tool',
        title: 'Legacy row',
        status: 'completed',
        hasDetail: false,
      });
      const tapped = await readRoomTools(db, { roomId: room, anchor: message, messageId: message }, viewer);
      expect(tapped.messages[0]!.activity![0]).toMatchObject({
        command: 'cat skills/waiting-and-wakes/SKILL.md',
        output: 'file contents',
        requestedBy: { name: 'Reader' },
      });
    } finally {
      await db.close();
    }
  });

  it('distinguishes same-message twin items (path-only vs diff), guards malformed JSONB, and sanitizes historical list + full rows', async () => {
    const db = new PgliteDatabase();
    const viewer = 'a'.repeat(64);
    const outsider = 'd'.repeat(64);
    const agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const message = 'e'.repeat(64);
    try {
      await migrate(db);
      await db.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'agent','Writer'),($3,'human','Outsider')`,
        [viewer, agent, outsider],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'proof')`, [room, workspace, viewer]);
      await db.query(`INSERT INTO memberships(room_id,workspace_id,identity_id,role) VALUES($1,$2,$3,'member'),(NULL,$2,$3,'member')`, [room, workspace, viewer]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,activity) VALUES($1,$2,$3,'','activity',$4::jsonb)`,
        [
          message,
          room,
          agent,
          JSON.stringify([
            // Non-tool note interleaved before tools to verify stable tool itemIndex ordering
            { kind: 'note', title: 'Note', text: 'Checking ChatTree' },
            // Twin item #0: path-only Read with historical agent-home prefix -> NO toolOutput
            {
              kind: 'tool',
              title: 'Read agent-home/codex/skills/beeline-connecting-services/SKILL.md',
              operation: 'read',
              status: 'completed',
              files: [{ path: 'agent-home/codex/skills/beeline-connecting-services/SKILL.md', line: 10, endLine: 40 }],
            },
            // Twin item #1: same title shape, has diff + exact counts + URI query secret in summary/output
            {
              kind: 'tool',
              title: 'Edit /home/lunchbox/.local/state/beeline/corners/abcdef0123456789/apps/mobile/ChatTree.tsx',
              operation: 'edit',
              status: 'completed',
              summary: 'Fetched mcp://linear/issues?token=supersecret&page=2',
              command: 'git diff /home/lunchbox/.local/state/beeline/corners/abcdef0123456789/apps/mobile/ChatTree.tsx',
              files: [
                {
                  path: '/home/lunchbox/.local/state/beeline/corners/abcdef0123456789/apps/mobile/ChatTree.tsx',
                  status: 'M',
                  addedLines: 6,
                  removedLines: 3,
                  diff: '@@ -1,2 +1,2 @@\n-/home/lunchbox/.local/state/beeline/corners/abcdef0123456789/old\n+new',
                },
              ],
              blocks: [
                { kind: 'resource', mode: 'link', uri: 'mcp://linear/issues?token=supersecret&page=2' },
              ],
            },
            // Malformed historical item: wrong JSON types and out-of-range PostgreSQL integers
            {
              kind: 'tool',
              title: 'Malformed historical',
              status: 'failed',
              exitCode: 'not-a-number',
              omittedCount: -5,
              files: 'not-an-array',
              blocks: 'not-an-array',
              plan: 'not-an-object',
            },
            // Out-of-range numeric values beyond 32-bit PostgreSQL integer bounds
            {
              kind: 'tool',
              title: 'Out-of-range integers',
              status: 'completed',
              exitCode: 9999999999999,
              omittedCount: 2147483648,
              files: [
                {
                  path: 'apps/server/src/overflow.ts',
                  addedLines: 3000000000,
                  removedLines: 99999999999,
                  line: 2147483648,
                  endLine: 4294967296,
                },
              ],
            },
          ]).replace(
            /\]$/,
            `,${[
              // Exact JSON numbers outside 64-bit PostgreSQL bigint range (kept verbatim so JSONB stores huge numeric values)
              '{"kind":"tool","title":"Out-of-range bigint","status":"completed","exitCode":99999999999999999999999999999,"omittedCount":9223372036854775808,"plan":{"items":"not-an-array"},"files":[{"path":"apps/server/src/bigint-overflow.ts","addedLines":99999999999999999999999999999,"removedLines":-99999999999999999999999999999,"line":1e30,"endLine":99999999999999999999}]}',
            ].join(',')}]`,
          ),
        ],
      );

      // Non-member is denied
      await expect(readRoomTools(db, { roomId: room, anchor: message }, outsider)).rejects.toMatchObject({
        status: 403,
      });

      const list = await readRoomTools(db, { roomId: room, anchor: message }, viewer);
      const items = list.messages[0]!.activity!;
      expect(items).toHaveLength(5);

      // Item 0: sanitized display path, line/endLine preserved, hasDetail=false, no toolOutput
      expect(items[0]).toMatchObject({
        title: 'Read skills/beeline-connecting-services/SKILL.md',
        files: [{ path: 'skills/beeline-connecting-services/SKILL.md', line: 10, endLine: 40 }],
        hasDetail: false,
      });
      expect(items[0]!.toolOutput).toBeUndefined();

      // Item 1: sanitized display path & URI secret, command operands preserved, itemIndex=1
      expect(items[1]).toMatchObject({
        title: 'Edit apps/mobile/ChatTree.tsx',
        summary: 'Fetched mcp://linear/issues?token=[REDACTED]&page=2',
        command: 'git diff /home/lunchbox/.local/state/beeline/corners/abcdef0123456789/apps/mobile/ChatTree.tsx',
        files: [{ path: 'apps/mobile/ChatTree.tsx', status: 'M', addedLines: 6, removedLines: 3 }],
        hasDetail: true,
        toolOutput: { roomId: room, anchor: message, messageId: message, itemIndex: 1, hasDetail: true },
      });
      expect(JSON.stringify(list)).not.toContain('supersecret');
      expect(JSON.stringify(items[0])).not.toContain('agent-home/codex/');

      // Item 2: malformed JSONB did not throw 500
      expect(items[2]).toMatchObject({
        kind: 'tool',
        title: 'Malformed historical',
        status: 'failed',
        hasDetail: false,
      });

      // Item 3: out-of-range integers dropped cleanly instead of aborting PostgreSQL cast
      expect(items[3]).toEqual({
        kind: 'tool',
        title: 'Out-of-range integers',
        status: 'completed',
        files: [{ path: 'apps/server/src/overflow.ts' }],
        hasDetail: false,
      });

      // Item 4: JSON numbers outside 64-bit PostgreSQL bigint range dropped cleanly without aborting cast
      expect(items[4]).toEqual({
        kind: 'tool',
        title: 'Out-of-range bigint',
        status: 'completed',
        files: [{ path: 'apps/server/src/bigint-overflow.ts' }],
        hasDetail: false,
      });

      // Full SQL response ALSO sanitizes display paths & URI secrets while leaving patch hunks faithful!
      const full = await readRoomTools(db, { roomId: room, anchor: message, messageId: message }, viewer);
      const fullItems = full.messages[0]!.activity!;
      expect(fullItems).toHaveLength(5);
      expect(fullItems[0]!.files?.[0]?.path).toBe('skills/beeline-connecting-services/SKILL.md');
      expect(fullItems[1]!.files?.[0]?.path).toBe('apps/mobile/ChatTree.tsx');
      // Patch hunk kept faithful (not rewritten by display prefix stripper)
      expect(fullItems[1]!.files?.[0]?.diff).toContain(
        '-/home/lunchbox/.local/state/beeline/corners/abcdef0123456789/old',
      );
      expect(fullItems[1]!.blocks?.[0]).toEqual({
        kind: 'resource',
        mode: 'link',
        uri: 'mcp://linear/issues?token=[REDACTED]&page=2',
      });
      expect(fullItems[1]!.sanitized).toBe(true);
      expect(JSON.stringify(full)).not.toContain('supersecret');
    } finally {
      await db.close();
    }
  });

  it('emits a fetch handle when list projection clips title, summary, command, or input and restores full text on open', async () => {
    const db = new PgliteDatabase();
    const viewer = 'a'.repeat(64);
    const agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const message = 'f'.repeat(64);
    const longTitle = `Long title ${'t'.repeat(250)} END_TITLE`;
    const longSummary = `Long summary ${'s'.repeat(210)} END_SUMMARY`;
    const longCommand = `echo ${'c'.repeat(520)} END_COMMAND`;
    const longInput = JSON.stringify({ query: `${'q'.repeat(520)} END_INPUT` });
    try {
      await migrate(db);
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'agent','Writer')`, [viewer, agent]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'proof')`, [room, workspace, viewer]);
      await db.query(`INSERT INTO memberships(room_id,workspace_id,identity_id,role) VALUES($1,$2,$3,'member'),(NULL,$2,$3,'member')`, [room, workspace, viewer]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,activity) VALUES($1,$2,$3,'','activity',$4::jsonb)`,
        [
          message,
          room,
          agent,
          JSON.stringify([
            { kind: 'tool', title: longTitle, status: 'completed' },
            { kind: 'tool', title: 'Summary clipped', summary: longSummary, status: 'completed' },
            { kind: 'tool', title: 'Command clipped', command: longCommand, status: 'completed' },
            { kind: 'tool', title: 'Input clipped', input: longInput, status: 'completed' },
          ]),
        ],
      );

      const list = await readRoomTools(db, { roomId: room, anchor: message }, viewer);
      const items = list.messages[0]!.activity!;
      expect(items).toHaveLength(4);
      items.forEach((item, index) => {
        expect(item.hasDetail).toBe(true);
        expect(item.toolOutput).toEqual({
          roomId: room,
          anchor: message,
          messageId: message,
          itemIndex: index,
          hasDetail: true,
        });
      });
      expect(items[0]!.title).not.toContain('END_TITLE');
      expect(items[1]!.summary).not.toContain('END_SUMMARY');
      expect(items[2]!.command).not.toContain('END_COMMAND');
      expect(items[3]!.input).not.toContain('END_INPUT');

      const opened = await readRoomTools(db, { roomId: room, anchor: message, messageId: message }, viewer);
      const fullItems = opened.messages[0]!.activity!;
      expect(fullItems[0]!.title).toBe(longTitle);
      expect(fullItems[1]!.summary).toBe(longSummary);
      expect(fullItems[2]!.command).toBe(longCommand);
      expect(fullItems[3]!.input).toBe(longInput);
    } finally {
      await db.close();
    }
  });
});
