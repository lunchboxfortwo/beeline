import { deliverMcpMemberWebhooks } from './rooms-mcp-members.js';
import { modelText } from './message-origin.js';
import { queueMessage } from './agent-command.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { renderWake } from '../../body/src/session-join/bridge.js';
import { AGENT, ROOM, describe, expect, fixtureScope1, fixtureScope3, it } from './test-support-rooms-mcp.test-support.js';

const ask = { question: 'Which output?', options: ['Web', 'Phone'] };
const runner = { node: '/proof/node', bundle: '/proof/beeline.mjs' };
const joined = { key: 'codex:/proof', agent: 'codex' as const, cwd: '/proof', name: 'Proof',
  server: 'https://proof.invalid', clientId: 'proof', cursor: '0', deliveredWakes: [], joinedAt: '' };

describe('replies without an ask end acknowledgement exchanges', () => {
  const scope = fixtureScope1(), tools = fixtureScope3(scope);
  const native = async () => (await readAgentCommands(scope.db, AGENT)).commands;

  it.each([0, 4, 623, 10000])('stops native, MCP and session acknowledgements at depth %i', async depth => {
    const { client } = await scope.connected();
    const sent = await tools.ok(client, 'message', { address: ROOM, to: { agent: AGENT, place: ROOM }, text: 'Inspect this' });
    await scope.db.query('UPDATE agent_commands SET agent_depth=$2 WHERE id=$1', [sent.id, depth]);
    const replied = await scope.daemon.execute('reply', { id: sent.id, text: 'Inspected' }, AGENT);
    const wake = (await tools.ok(client, 'list_mentions', {})).wakes[0];
    expect(wake).toMatchObject({ id: replied.id, reason: 'reply' });
    expect((await scope.db.query('SELECT agent_depth FROM agent_commands WHERE id=$1',[replied.id])).rows).toEqual([{agent_depth:depth+1}]);
    expect(wake.next).toContain(`id: ${replied.id}\nReply needed: false\ntext: Inspected`);
    expect(wake.next).not.toMatch(/Reply\(id|no_reply_needed|message\(/);
    const session = renderWake(wake, joined, runner);
    expect(session).toContain('Reply needed: false');
    expect(session).not.toMatch(/Reply\(id|tool /);
    const ack = await tools.ok(client, 'reply', { id: replied.id, text: 'Received' });
    expect(ack.receipt).toBe('Message stored and visible. No agents woken. An acknowledgement of an informational reply wakes no one; add ask or use message() to reach them.');
    expect(await native()).toEqual([]);
    expect((await tools.ok(client, 'list_mentions', {})).wakes).toEqual([]);
    expect((await scope.db.query('SELECT text FROM messages WHERE id=$1', [ack.id])).rows).toEqual([{ text: 'Received' }]);
    expect((await scope.db.query("SELECT id FROM agent_commands WHERE id=$1 OR parent_command_id=$1 AND reason='reply'", [sent.id])).rows).toHaveLength(2);

    // A genuinely new request still wakes the other agent at any depth.
    const fresh = await tools.ok(client, 'message', { address: ROOM, to: { agent: AGENT, place: ROOM }, text: 'Check another item' });
    await scope.daemon.execute('reply', { id: fresh.id, text: 'Checked', ask }, AGENT);
    const question = (await tools.ok(client, 'list_mentions', {})).wakes[0];
    expect(question.next).toContain(`Reply needed: true\ntext: Checked\nReply(id: ${question.id}, text: ...) with your reply`);
    expect(await tools.ok(client,'no_reply_needed',{address:ROOM,commandId:question.id})).toEqual({cleared:0});
    expect(renderWake(question, joined, runner)).toContain(`Reply(id: ${question.id}, text: ...) with your reply`);
    const answer = await tools.ok(client, 'reply', { id: question.id, text: 'Web; which size?', ask });
    const command = (await native()).find(item => item.id === answer.id)!;
    expect(itemPrompt(command, { names: new Map() })).toContain(`Reply needed: true\ntext: Web; which size?\nReply(id: ${command.id}, text: ...) with your reply`);
    const last = await scope.daemon.execute('reply', { id: command.id, text: 'Large' }, AGENT);
    const [information] = (await tools.ok(client, 'list_mentions', {})).wakes;
    expect(information.id).toBe(last.id);
    expect(information.next).toContain('Reply needed: false');
    expect(information.next).not.toContain('Reply(id');
    expect(await tools.ok(client, 'no_reply_needed', { address: ROOM, commandId: information.id })).toEqual({ cleared: 1 });
    expect((await tools.ok(client, 'list_mentions', {})).wakes).toEqual([]);
  });

  it.each(['events', 'webhook'])('%s delivers informational replies without a reply instruction, and asked replies with one', async route => {
    const { client, member, token, params, grant } = await scope.eventFixture();
    if (route === 'events') expect((await scope.eventCall(token, 'events/subscribe', { ...params, name: 'wake' })).error).toBeUndefined();
    else await scope.db.query('UPDATE rooms_mcp_clients SET callback_url=$2 WHERE id=$1', [grant.clientId, params.delivery.url]);
    for (const asked of [false, true]) {
      const sent = await tools.ok(client, 'message', { address: ROOM, to: { agent: AGENT, place: ROOM }, text: 'Inspect' });
      const replied = await scope.daemon.execute('reply', { id: sent.id, text: 'Inspected', ...(asked ? {ask} : {}) }, AGENT);
      let next: string;
      if (route === 'events') {
        const rows = await scope.db.query<{body:string}>('SELECT body FROM rooms_mcp_event_deliveries WHERE command_id=$1', [replied.id]);
        expect(rows.rows).toHaveLength(1);
        next = JSON.parse(rows.rows[0]!.body).data.next;
      } else {
        const received: {instruction:string;next:string}[] = [];
        await deliverMcpMemberWebhooks(scope.db, async (_url, init) => { received.push(JSON.parse(init.body)); return new Response(null, {status:204}); });
        expect(received).toHaveLength(1);
        next = received[0]!.next;
        expect(received[0]!.instruction).toBe(next);
      }
      expect(next!.includes(`Reply(id: ${replied.id}, text: ...) with your reply`)).toBe(asked);
      expect(next!).toContain(`Reply needed: ${asked}`);
      expect(next!).not.toContain('no_reply_needed');
      const wake = (await tools.ok(client, 'list_mentions', {})).wakes.find((wake:{id:string})=>wake.id===replied.id);
      if (route === 'events') expect(wake.next).toBe(next!);
      else expect(wake).toBeUndefined();
      await tools.ok(client, 'reply', {id:replied.id,text:'Received'});
      if (!asked) expect(await native()).toEqual([]);
      else expect(await native()).toHaveLength(1);
      await scope.db.query("UPDATE agent_commands SET state='complete' WHERE state='pending'");
    }
    expect(member).toBeTruthy();
  });

  it.each([false, true])('records self-messages and replies without a wake, ask=%s', async asked => {
    const args = asked ? {ask} : {};
    const self = await scope.daemon.execute('message', {roomId:ROOM,to:{agent:AGENT,place:ROOM},text:'Note to self',...args}, AGENT);
    expect(await native()).toEqual([]);
    expect(self).toMatchObject({receipt:'Message stored and visible. No agents woken. You addressed yourself; do the work in this turn.'});
    expect((await scope.db.query('SELECT text FROM messages WHERE id=$1',[self.id])).rows).toEqual([{text:'Note to self'}]);
    // Already queued self-addressed commands from older servers can be answered
    // without feeding another item back to the sender.
    const legacy = (await queueMessage(scope.db,{roomId:ROOM,agentId:AGENT,sourceMessageId:null,reason:'message',
      privatePayload:{kind:'message',route:{from:{agent:AGENT,place:ROOM},to:{agent:AGENT,place:ROOM}},
        authorId:AGENT,fromRoomId:ROOM,text:modelText('Old self-addressed task')}}))!;
    const replied = await scope.daemon.execute('reply',{id:legacy.id,text:'Recorded',...args}, AGENT);
    expect(replied).toMatchObject({receipt:expect.stringContaining('You addressed yourself')});
    expect(await native()).toEqual([]);
    expect((await scope.db.query('SELECT text FROM messages WHERE id=$1',[replied.id])).rows).toEqual([{text:'Recorded'}]);
  });

  it('lets native agents silently handle an informational reply and keeps asks owed', async () => {
    const { client, member } = await scope.connected();
    const sent = await scope.daemon.execute('message', { roomId: ROOM, to: { agent: member, place: ROOM }, text: 'Inspect' }, AGENT);
    const replied = await tools.ok(client, 'reply', { id: sent.id, text: 'Inspected' });
    const command = (await native()).find(item => item.id === replied.id)!;
    const prompt = itemPrompt(command, { names: new Map() });
    expect(prompt).toContain('Reply needed: false');
    expect(prompt).not.toMatch(/Reply\(id|no_reply_needed|message\(/);
    expect(await scope.daemon.execute('markAgentTurnSilent', { roomId: ROOM, requestId: command.id }, AGENT)).toMatchObject({ answered: true });
    expect(await native()).toEqual([]);
    const oldAck = await scope.daemon.execute('reply',{id:command.id,text:'Received'},AGENT);
    expect((await tools.ok(client,'list_mentions',{})).wakes).toEqual([]);
    expect((await scope.db.query('SELECT text FROM messages WHERE id=$1',[oldAck.id])).rows).toEqual([{text:'Received'}]);
    const question = await tools.ok(client, 'reply', { id: sent.id, text: 'Which output?', ask });
    expect(await scope.daemon.execute('markAgentTurnSilent', { roomId: ROOM, requestId: question.id }, AGENT)).toMatchObject({ answered: false });
  });
});
