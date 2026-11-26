import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { readRoomTools } from './room-tool-projection.js';

describe('stored tool output disclosure', () => {
  it('keeps bodies out of the step list and returns them only for a tapped message', async () => {
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
      const list = await readRoomTools(db, {roomId:room,anchor:message}, viewer);
      expect(list.messages[0]!.activity![0]).not.toHaveProperty('output');
      expect(list.messages[0]!.activity![0]).toMatchObject({
        title: 'Read',
        command: 'cat skills/waiting-and-wakes/SKILL.md',
        input: '{"path":"skills/waiting-and-wakes/SKILL.md"}',
        files: [{ path: 'skills/waiting-and-wakes/SKILL.md' }],
        toolOutput: { roomId: room, anchor: message, messageId: message },
      });
      expect(list.messages[0]!.activity![1]).toEqual({
        kind: 'tool',
        title: 'Legacy row',
        status: 'completed',
        toolOutput: { roomId: room, anchor: message, messageId: message },
      });
      const tapped = await readRoomTools(db, {roomId:room,anchor:message,messageId:message}, viewer);
      expect(tapped.messages[0]!.activity![0]).toMatchObject({
        command: 'cat skills/waiting-and-wakes/SKILL.md',
        output: 'file contents',
        requestedBy: { name: 'Reader' },
      });
    } finally {
      await db.close();
    }
  });
});
