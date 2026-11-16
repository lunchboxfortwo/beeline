import { queueMessage } from './agent-command.js';
import { SYSTEM_AUTHOR_ID, systemText } from './message-origin.js';
import { MCP_RETIRED_TOOLS } from './rooms-mcp-agent.js';
import { AGENT, PUBLIC_CORNER, ROOM, USER, WORKSPACE, beforeAll, beforeEach, describe, expect, fixtureScope1, fixtureScope3, it } from './test-support-rooms-mcp.test-support.js';

const REVIEWER = 'e'.repeat(64);
const DM = '66666666-6666-4666-8666-666666666666', SIBLING = '77777777-7777-4777-8777-777777777777';
const ask = { question: 'Which output?', options: ['Web', 'Phone'] };
const THREAD = PUBLIC_CORNER;

/** Condition 4: external agents send to and receive from thread agents and commanders with the same routing. */
describe('C4: external agents route like native agents', () => {
  const scope = fixtureScope1(), tools = fixtureScope3(scope);
  const db = () => scope.db;
  beforeAll(async () => {
    await db().query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Sol','sol')", [REVIEWER]);
    await db().query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [REVIEWER, USER]);
    await db().query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')", [WORKSPACE, ROOM, REVIEWER]);
    await db().query("INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Sibling',$3)", [SIBLING, WORKSPACE, ROOM]);
  });
  beforeEach(async () => {
    await db().query("DELETE FROM agent_commands");
    await db().query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [ROOM, REVIEWER]);
    await db().query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1', [THREAD, AGENT]);
  });
  /** A connected external member, also reachable in a DM with its person. */
  async function external() {
    const connected = await scope.connected();
    await db().query('DELETE FROM rooms WHERE id=$1', [DM]);
    await db().query("INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))", [DM, WORKSPACE, USER, connected.member]);
    for (const member of [USER, connected.member]) await db().query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')", [WORKSPACE, DM, member]);
    return connected;
  }
  const places = { chat: ROOM, dm: DM, thread: THREAD, sibling: SIBLING } as const;
  const roles = { implementer: AGENT, reviewer: REVIEWER } as const;
  const pending = async (agent: string) => (await db().query<{ id: string; room_id: string; from: unknown; ask: unknown }>(
    `SELECT id,room_id,message->'route'->'from' "from",private_payload->'messageAsk' ask FROM agent_commands
     WHERE agent_id=$1 AND state='pending' AND reason<>'mcp_call' ORDER BY created_at,id`, [agent])).rows;
  const settle = () => db().query("UPDATE agent_commands SET state='complete' WHERE state='pending'");
  const wake = async (agent: string, reason = 'corner_check') => (await queueMessage(db(), { roomId: THREAD, agentId: agent, sourceMessageId: null, reason,
    privatePayload: { kind: 'lifecycle', authorId: SYSTEM_AUTHOR_ID, fromRoomId: THREAD, text: systemText('Checks failed') } }))!;

  it.each(Object.entries(places).flatMap(([name, id]) => Object.entries(roles).map(([role, worker]) => [name, role, id, worker] as const)))(
    'an external commander in the %s messages the thread %s over MCP and receives plain, ask and blocked replies there', async (_name, role, place, worker) => {
      const { client, member } = await external();
      const sent = await tools.ok(client, 'message', { address: place, to: { agent: role, place: THREAD }, text: 'Build widget' });
      expect((await pending(worker)).map(row => row.room_id)).toEqual([THREAD]);
      await settle();
      await scope.daemon.execute('reply', { id: sent.id, text: 'Done' }, worker);
      await scope.daemon.execute('reply', { id: sent.id, text: 'blocked: need a choice', ask }, worker);
      // A System wake in the thread continues the commander's task.
      if (role === 'implementer') await scope.daemon.execute('reply', { id: (await wake(worker)).id, text: 'blocked: build access', ask }, worker);
      const wakes = (await tools.ok(client, 'list_mentions', {})).wakes as { address: string; from: unknown }[];
      expect(wakes.map(item => [item.address, item.from])).toEqual(
        Array(role === 'implementer' ? 3 : 2).fill([place, { agent: worker, place: THREAD }]));
      expect((await pending(member)).map(row => Boolean(row.ask))).toEqual(role === 'implementer' ? [false, true, true] : [false, true]);
    });

  it.each(Object.entries(places))('an external thread implementer replies over MCP to a native commander in the %s, including after a System wake', async (_place, place) => {
    const { client, member } = await external();
    await db().query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1', [THREAD, member]);
    if (place === DM) await db().query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')", [WORKSPACE, DM, AGENT]);
    const sent = await scope.daemon.execute('message', { roomId: place, to: { agent: 'implementer', place: THREAD }, text: 'Build widget' }, AGENT);
    const received = (await tools.ok(client, 'list_mentions', {})).wakes as { id: string; address: string; from: unknown }[];
    expect(received.map(item => [item.id, item.address, item.from])).toEqual([[sent.id, THREAD, { agent: AGENT, place }]]);
    await tools.ok(client, 'reply', { id: sent.id, text: 'Done' });
    const system = await wake(member);
    await tools.ok(client, 'reply', { id: system.id, text: 'blocked: build access', ask });
    expect((await pending(AGENT)).map(row => [row.room_id, row.from, Boolean(row.ask)])).toEqual([
      [place, { agent: member, place: THREAD }, false],
      [place, { agent: member, place: THREAD }, true],
    ]);
    // Condition 3 for an external worker: none of its work was queued outside the thread.
    expect((await db().query("SELECT room_id FROM agent_commands WHERE agent_id=$1 AND room_id<>$2 AND reason<>'mcp_call'", [member, THREAD])).rows).toEqual([]);
  });

  it('a joined session uses the same tools/call request as usebeeline session reply --reply-to and session tool message', async () => {
    const { token, member } = await external();
    await db().query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1', [THREAD, member]);
    // The exact JSON-RPC body and headers of the body's session-join callTool.
    const session = async (name: string, args: Record<string, unknown>) => {
      const response = await scope.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        { authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', accept: 'application/json' });
      const value = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
      expect(value.result.isError, value.result.content[0]!.text).toBeFalsy();
      return JSON.parse(value.result.content[0]!.text).data;
    };
    const sent = await scope.daemon.execute('message', { roomId: ROOM, to: { agent: 'implementer', place: THREAD }, text: 'Build widget' }, AGENT);
    await session('reply', { id: sent.id, text: 'Done' });
    await session('reply', { id: (await wake(member)).id, text: 'blocked: build access' });
    const asked = await session('message', { address: THREAD, to: { agent: 'reviewer', place: THREAD }, text: 'Please review', ask });
    expect((await pending(AGENT)).map(row => row.room_id)).toEqual([ROOM, ROOM]);
    await scope.daemon.execute('reply', { id: asked.id, text: 'Approved' }, REVIEWER);
    expect((await session('list_mentions', {})).wakes.map((item: { address: string; from: unknown }) => [item.address, item.from]))
      .toEqual([[THREAD, { agent: REVIEWER, place: THREAD }]]);
  });

  it('a host with a stale cached tool list learns each replacement, can read its wakes, and cannot answer them until refreshed', async () => {
    const { client, member } = await external();
    for (const [name, replacement] of Object.entries(MCP_RETIRED_TOOLS))
      expect(await tools.call(client, name, {})).toEqual({ error: true, text: `Request refused: ${name} is retired: ${replacement}.` });
    await db().query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1', [THREAD, member]);
    const sent = await scope.daemon.execute('message', { roomId: ROOM, to: { agent: 'implementer', place: THREAD }, text: 'Build widget' }, AGENT);
    // list_mentions and post predate the messaging tools, so a stale host still has them.
    const [received] = (await tools.ok(client, 'list_mentions', {})).wakes as { id: string; next: string }[];
    expect(received).toMatchObject({ id: sent.id, next: expect.stringContaining(`reply(${sent.id},text)`) });
    // A public post is conversation; only reply(id) answers the recorded sender.
    for (const address of [ROOM, THREAD]) await tools.ok(client, 'post', { address, text: 'Done' });
    expect(await pending(AGENT)).toEqual([]);
    expect((await pending(member)).map(row => row.id)).toEqual([sent.id]);
  });
});
