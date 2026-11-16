import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { migrate, type SqlDatabase } from './database.js';
import { COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion } from './command-completion.js';
import { serveMcpMemberStream } from './rooms-mcp-stream.js';
import { migratedDatabase } from './test-support.js';

class Reply extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0;
  frames: Record<string, any>[] = [];
  writeHead() {} flushHeaders() {}
  write(text: string) { this.frames.push(JSON.parse(text)); this.emit('frame'); return true; }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit('close'); } }
  until(count: number): Promise<void> {
    if (this.frames.length >= count) return Promise.resolve();
    return new Promise(resolve => {
      const inspect = () => { if (this.frames.length >= count) { this.off('frame', inspect); resolve(); } };
      this.on('frame', inspect);
    });
  }
}

describe('member stream survives an interrupted release migration', () => {
  it.each(['authority function', 'source trigger'])('keeps live delivery and restart replay after failure at %s', async failure => {
    const db = await migratedDatabase();
    const release = await db.client.listen(COMMAND_COMPLETION_CHANNEL, notifyCommandCompletion);
    const owner = 'a'.repeat(64), member = 'b'.repeat(64);
    const room = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222';
    const principal = { hash: 'synthetic-token', client_id: 'client', identity_id: owner, member_id: member, scope: 'rooms:read' };
    const live = new Reply(), restarted = new Reply(), frozen = new Reply();
    try {
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Claude')`, [owner, member]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'room','public')`, [room, workspace]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace, room, member]);
      await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('client','Claude','[]');`);
      await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES('client',$1,'rooms:read');`, [owner]);
      await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label) VALUES('client',$1,$2,'Claude')`, [owner, member]);
      await db.query(`INSERT INTO rooms_mcp_tokens(hash,client_id,identity_id,scope,expires_at)
        VALUES('synthetic-token','client',$1,'rooms:read',now()+interval '1 day')`, [owner]);
      const source = async () => (await db.query<{definition: string}>(
        `SELECT pg_get_functiondef('beeline_mcp_stream_source()'::regprocedure) definition`)).rows[0]!.definition;
      await db.query((await source()).replace('BEGIN', 'BEGIN\n -- preceding serving definition'));
      const originalSource = await source();
      // A preceding release's trigger has a different definition, so the real
      // installer must replace it instead of taking its unchanged-trigger skip.
      await db.query(`DROP TRIGGER beeline_mcp_stream_source ON rooms_mcp_mentions;
        CREATE TRIGGER beeline_mcp_stream_source AFTER INSERT OR UPDATE ON rooms_mcp_mentions
        FOR EACH ROW EXECUTE FUNCTION beeline_mcp_stream_source();`);
      const triggers = () => db.query(`SELECT tgrelid::regclass::text relation,tgname,pg_get_triggerdef(oid) definition
        FROM pg_trigger WHERE tgname='beeline_mcp_stream_source' ORDER BY 1`);
      const original = (await triggers()).rows;
      const head = (await db.query<{epoch: string; through: number}>(
        `SELECT epoch,sequence::integer through FROM live_streams WHERE id='mcp:'||$1`, [member])).rows[0]!;
      const page = vi.fn(async (tx: SqlDatabase, after: string) => {
        const mentions = (await tx.query<{id: string; room_id: string; deliveryCursor: string}>(
          `SELECT message_id id,room_id,'Synthetic mention' text,seq::text "deliveryCursor" FROM rooms_mcp_mentions
          WHERE member_id=$1 AND seq>$2 AND cleared_at IS NULL ORDER BY seq`, [member, after])).rows;
        return { mentions, wakes: [], nextCursor: mentions.at(-1)?.deliveryCursor ?? after, more: false };
      });
      await serveMcpMemberStream(db, principal, live as unknown as ServerResponse, { cursor: head, mentionCursor: '898' }, page);
      expect(page).toHaveBeenCalledTimes(1);
      const lockError = Object.assign(new Error('synthetic release lock timeout'), { code: '55P03' });
      let failed = false;
      const interrupt = (target: SqlDatabase): SqlDatabase => ({
        query: (sql, values) => {
          const point = failure === 'authority function'
            ? sql.includes('CREATE OR REPLACE FUNCTION beeline_router_authority()')
            : /CREATE TRIGGER beeline_mcp_stream_source AFTER INSERT OR UPDATE OR DELETE ON rooms_mcp_mentions/.test(sql);
          if (point) { failed = true; return Promise.reject(lockError); }
          return target.query(sql, values);
        },
        transaction: work => target.transaction(tx => work(interrupt(tx))),
      });
      // Execute the actual release path, including the earlier OAuth schema,
      // and stop before the source trigger can be restored by a later step.
      await expect(migrate(interrupt(db), { deferData: true })).rejects.toBe(lockError);
      expect(failed).toBe(true);
      expect((await triggers()).rows).toEqual(original);
      expect(await source()).toBe(originalSource);
      const delivered = live.until(3);
      await db.query(`INSERT INTO rooms_mcp_mentions(seq,member_id,room_id,message_id) VALUES(920,$1,$2,'owed')`, [member, room]);
      const current = (await db.query<{through: number}>(`SELECT sequence::integer through FROM live_streams WHERE id='mcp:'||$1`, [member])).rows[0]!;
      expect(current.through).toBe(head.through + 1);
      await delivered;
      expect(live.frames[1]).toMatchObject({ type: 'delivery', deliveryId: 'mention:owed:0', mentionCursor: '920' });
      live.end();
      // A restarted bridge still has the pre-release checkpoint and mention
      // cursor 898. The committed source must move its head and force replay.
      await serveMcpMemberStream(db, principal, restarted as unknown as ServerResponse, { cursor: head, mentionCursor: '898' }, page);
      expect(restarted.frames[0]).toMatchObject({ type: 'delivery', deliveryId: 'mention:owed:0', mentionCursor: '920' });
      expect(restarted.frames[1]).toMatchObject({ type: 'checkpoint', cursor: { through: head.through + 1 }, mentionCursor: '920' });
      restarted.end();
      // Recover an inbox already damaged by the preceding installer: its
      // mention committed while the journal source trigger was absent.
      await db.transaction(async tx => {
        await tx.query('ALTER TABLE rooms_mcp_mentions DISABLE TRIGGER beeline_mcp_stream_source');
        await tx.query(`INSERT INTO rooms_mcp_mentions(seq,member_id,room_id,message_id) VALUES(921,$1,$2,'unjournaled')`, [member, room]);
        await tx.query('ALTER TABLE rooms_mcp_mentions ENABLE TRIGGER beeline_mcp_stream_source');
      });
      const frozenHead = { epoch: head.epoch, through: head.through + 1 };
      expect((await db.query<{through: number}>(`SELECT sequence::integer through FROM live_streams WHERE id='mcp:'||$1`, [member])).rows[0]?.through)
        .toBe(frozenHead.through);
      await serveMcpMemberStream(db, principal, frozen as unknown as ServerResponse, { cursor: frozenHead, mentionCursor: '920' }, page);
      expect(frozen.frames[0]).toMatchObject({ type: 'delivery', deliveryId: 'mention:unjournaled:0', mentionCursor: '921' });
      expect(frozen.frames[1]).toMatchObject({ type: 'checkpoint', cursor: frozenHead, mentionCursor: '921' });
    } finally {
      live.end(); restarted.end(); frozen.end(); await release(); await db.close();
    }
  }, 30_000);
});
