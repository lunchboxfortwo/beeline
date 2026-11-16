import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { AGENT,CORNER,cornerOwnerSql,createAgentCommand,describe,expect,fixtureScope1,fixtureScope3,it,PUBLIC_CORNER,randomUUID,ROOM,USER,WORKSPACE } from './test-support-rooms-mcp.test-support.js';

describe('chats connector HTTP OAuth and MCP', () => {
const scope1 = fixtureScope1();
describe('agent tools for a connected app', () => {
const scope3 = fixtureScope3(scope1);

    it('R-MCP-PROGRESS: post progress:true records a progress line in the thread, not a message', async () => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      expect(await scope3.ok(client, 'post', { address: corner, text: 'Read the brief; running the tests next.', progress: true }))
        .toEqual({ recorded: true, address: corner });
      const rows = (await scope1.db.query<{ presentation: string; text: string; activity: { kind: string; title: string; text: string }[] | null }>(
        `SELECT presentation,text,activity FROM messages WHERE room_id=$1 AND author_id=$2 ORDER BY created_at`, [corner, member])).rows;
      expect(rows).toEqual([{ presentation: 'activity', text: '', activity: [{ kind: 'output', title: 'Update', text: 'Read the brief; running the tests next.' }] }]);
      // The one-call turn closed, and no wake was queued for anyone.
      expect((await scope1.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'`, [corner, member])).rowCount).toBe(0);
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id<>$2 AND state='pending'`, [corner, member])).rowCount).toBe(0);
      expect((await scope3.call(client, 'post', { address: ROOM, text: 'not a thread', progress: true })).text).toContain('progress lines go in a thread');
    });







    it('R-MCP-GATES: keeps reviewer, merge, hold and implementer gates for the app', async () => {
      const { client, member } = await scope1.connected();
      // Not the configured reviewer: no PASS.
      const pass = await scope3.call(client, 'approve_merge', { address: PUBLIC_CORNER, headSha: 'a'.repeat(40) });
      expect(pass.error).toBe(true);
      expect(pass.text).toMatch(/NOT_CONFIGURED_REVIEWER|reviewer/);
      // No pull request and no checks: the merge gate stays closed.
      expect((await scope3.call(client,'merge_thread',{address:PUBLIC_CORNER})).error).toBe(true);
      // Agent callers must cite a readable person's request.
      const hold = await scope3.call(client, 'set_thread_hold', { address: PUBLIC_CORNER });
      expect(hold.error).toBe(true);
      expect(hold.text).toContain('close the PR to stop it');
      // A person's tag makes that person the requester, as it does for an agent turn.
      const handle0 = (await scope1.db.query<{ handle: string }>('SELECT beeline_room_handle(id,$2) handle FROM identities WHERE id=$1', [member,ROOM])).rows[0]!.handle;
      const request = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle0} hold the demo thread` }, USER);
      const command=(await scope1.db.query<{id:string}>('SELECT id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2',[member,request.messageId])).rows[0]!;
      const held=await scope3.ok(client,'set_thread_hold',{address:PUBLIC_CORNER,commandId:command.id,sourceMessageId:request.messageId});
      expect(held.holdId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await scope3.ok(client, 'set_thread_hold', {address:PUBLIC_CORNER,commandId:command.id,releaseHoldId:held.holdId})).toBeDefined();
      // An app has no checkout, so repository work needs another implementer.
      const repoRoom = randomUUID();
      await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,visibility,repository_key,repository_remote,repository_resolution)
        VALUES($1,$2,'Repo','public','acme/repo','https://github.com/acme/repo.git','repository')`, [repoRoom, WORKSPACE]);
      await scope1.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [WORKSPACE, repoRoom, member, AGENT]);
      const handle = (await scope1.db.query<{ handle: string }>('SELECT beeline_room_handle(id,$2) handle FROM identities WHERE id=$1', [member,ROOM])).rows[0]!.handle;
      const self = await scope3.call(client, 'open_thread', { room: repoRoom, implementer: handle, brief: { spec: 'Fix the login copy.' } });
      expect(self.error).toBe(true);
      expect(self.text).toContain('cannot implement repository work; name another agent as implementer');
      expect((await scope1.db.query('SELECT 1 FROM rooms WHERE parent_id=$1', [repoRoom])).rowCount).toBe(0);
    });



    it('R-MCP-CORNER: opens a thread with another implementer and posts in it', async () => {
      const { client } = await scope1.connected();
      const opened = await scope3.ok(client, 'open_thread', { room: ROOM, name: 'nebula-check', objective: 'Check the nebula numbers',
        implementer: 'demo-agent', brief: { spec: '## Intent\nCheck the nebula numbers.', repositoryWork: false } });
      expect(opened.status).toBe('starting');
      const corner = opened.address as string;
      expect((await scope1.db.query<{ owner_agent_id: string }>(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [corner])).rows[0]?.owner_agent_id).toBeDefined();
      const posted = await scope3.ok(client, 'post', { address: corner, text: 'Numbers attached below.' });
      expect(posted.stored).toBe(true);
      expect((await scope3.call(client,'react_to_message',{address:corner,messageId:posted.id,emoji:'👀'})).error).toBe(true);
      expect((await scope3.ok(client, 'read', { facet: 'brief', address: corner })).revisions?.length ?? 1).toBeGreaterThan(0);
    });
});
});
