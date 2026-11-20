import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { vi } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { serveMcpMemberStream } from './rooms-mcp-stream.js';
import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { ROOM, USER, createAgentCommand, describe, expect, fixtureScope1, it, tokenHash } from './test-support-rooms-mcp.test-support.js';

class Reply extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0;
  frames: any[] = [];
  writeHead() {} flushHeaders() {}
  write(raw: string) { this.writableLength += Buffer.byteLength(raw); this.frames.push(JSON.parse(raw)); return false; }
  end() { this.writableEnded = true; this.emit('close'); }
}

describe('MCP member stream pending backlog', () => {
  const scope = fixtureScope1();
  it.each([false, true])('delivers a new tag past old replies and an obsolete idle wake (oversized=%s)', async oversized => {
    const { client, member, token, grant } = await scope.connected();
    const setup = await client.callTool({ name: 'setup_delivery', arguments: {
      mechanism: 'local', host: 'Claude', surface: 'CLI', conversation: 'synthetic-session', installed: true,
    } });
    expect(setup.isError).not.toBe(true);
    const old: string[] = [];
    for (let i = 0; i < 35; i++) {
      const item = await createAgentCommand(scope.db, { roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'reply',
        privatePayload: { kind: 'reply', authorId: USER, fromRoomId: ROOM, text: `Old reply ${i}` } });
      old.push(item!.id);
    }
    const idle = await createAgentCommand(scope.db, { roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'system',
      privatePayload: { kind: 'report', authorId: SYSTEM_IDENTITY_ID, fromRoomId: ROOM, text: 'Obsolete idle episode',
        automatic: true, idleSince: '1795054571.286801' } });
    const handle = (await scope.db.query<{ handle: string }>('SELECT beeline_room_handle($1,$2) handle', [member, ROOM])).rows[0]!.handle;
    const tag = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} Please investigate` }, USER);
    const command = (await scope.db.query<{ id: string }>('SELECT id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2', [member, tag.messageId])).rows[0]!;
    // This proof is about backlog size on a live stream: the work counts as
    // queued while connected. A reconnect retiring work queued before the
    // connector was last seen offline is covered by connector-reconnect.test.ts.
    await scope.db.query('UPDATE rooms_mcp_members SET disconnected_at=NULL WHERE member_id=$1', [member]);
    if (oversized) await scope.db.query(`UPDATE agent_commands SET message=jsonb_set(message,'{body}',to_jsonb(repeat('x',400000)))
      WHERE id=ANY($1::text[])`, [old.slice(0, 3)]);
    await scope.db.query("UPDATE live_streams SET sequence=1925 WHERE id='mcp:'||$1", [member]);
    const { epoch } = (await scope.db.query<{ epoch: string }>("SELECT epoch FROM live_streams WHERE id='mcp:'||$1", [member])).rows[0]!;
    const output = new Reply(), errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await serveMcpMemberStream(scope.db, { member_id: member, hash: tokenHash(token), client_id: grant.clientId, identity_id: USER, scope: 'rooms:read rooms:write' },
        output as unknown as ServerResponse, { cursor: { epoch, through: 1920 }, mentionCursor: '2911' }, async db => ({
          mentions: [], wakes: await pendingMcpWakes(db, member), nextCursor: '2911', more: false,
        }));
      expect(output.frames.find(frame => frame.deliveryId === `wake:${command.id}`), errors.mock.calls.map(call => String(call[1])).join('\n')).toBeDefined();
      expect(output.frames.some(frame => frame.type === 'ended')).toBe(false);
      expect(output.frames.some(frame => frame.type === 'checkpoint' && frame.cursor.through === 1925)).toBe(true);
      expect(output.frames.some(frame => frame.deliveryId === `wake:${idle!.id}`)).toBe(false);
      expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [idle!.id])).rows).toEqual([{ state: 'complete' }]);
      // Retiring the idle wake is itself a committed hint; a covering drain may
      // redeliver the durable pending items under their same inbox identities.
      expect(new Set(output.frames.filter(frame => old.includes(frame.wakes?.[0]?.id)).map(frame => frame.deliveryId)).size).toBe(35);
      if (oversized) {
        expect(output.frames.find(frame => frame.deliveryId === `wake:${old[0]}`).wakes[0].text).toHaveLength(400000);
        expect(output.writableLength).toBeGreaterThan(1024 * 1024);
      }
      expect(output.writableEnded).toBe(false);
      expect((await scope.db.query('SELECT mechanism,stream_id,failure FROM rooms_mcp_delivery WHERE member_id=$1', [member])).rows)
        .toEqual([{ mechanism: 'local', stream_id: expect.any(String), failure: null }]);
      expect(errors).not.toHaveBeenCalled();
    } finally { output.end(); errors.mockRestore(); }
  });
});
