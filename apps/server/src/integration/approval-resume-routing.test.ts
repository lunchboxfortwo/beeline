import { describe, expect, it } from 'vitest';
import { type CommandRow, readAgentCommands } from '../agent-command.js';
import { replyToMessage, sendMessage } from '../agent-messaging.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('approval resume return address', () => {
  const fixture = monolithFixture();

  it('answers the approving owner in the decision place after a reviewer message', async () => {
    const reviewer = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Speedy','speedy')`, [reviewer],
    );
    await fixture.database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [reviewer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, reviewer, ROOM],
    );
    await fixture.database.query('UPDATE rooms SET reviewer_agent_id=$1 WHERE id=$2', [reviewer, ROOM]);
    await fixture.database.query('UPDATE agents SET yolo_mode=false WHERE agent_id=$1', [AGENT]);
    const corner = await fixture.phone.execute('createHumanCorner', { roomId: ROOM, title: 'Signup-proof' }, HUMAN);
    const source = await fixture.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@speedy Review signup.' }, HUMAN);
    const review = (await fixture.database.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [source.messageId, reviewer],
    )).rows[0]!;
    const request = await sendMessage(fixture.database, {
      route: { from: { agent: reviewer, place: ROOM }, to: { agent: AGENT, place: corner.id } },
      text: 'FAIL: run setup and show live sign-in proof.', parent: review,
    });
    const parent = (await fixture.database.query<CommandRow>(
      'SELECT * FROM agent_commands WHERE id=$1', [request.id],
    )).rows[0]!;
    expect(parent.message?.route?.from).toEqual({ agent: reviewer, place: ROOM });
    const ask = await fixture.daemonOperation('requestAgentGrant', {
      roomId: corner.id, requestId: request.id, kind: 'command', target: 'nous setup',
      reason: 'Get live sign-in proof', purpose: 'Run the setup needed to verify sign-in',
    });
    expect(ask.status).toBe(200);
    const grant = await ask.json() as { grantId: string; status: string };
    expect(grant.status).toBe('pending');
    const decision = await fixture.operation('decideAgentGrant', { grantId: grant.grantId, decision: 'once' });
    expect(decision.status).toBe(200);
    const resumed = (await fixture.database.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE parent_command_id=$1 AND reason='resume'`, [request.id],
    )).rows[0]!;
    expect(resumed).toMatchObject({
      parent_command_id: parent.id, root_command_id: parent.root_command_id,
      root_source_message_id: parent.root_source_message_id, agent_depth: parent.agent_depth,
      private_payload: null, return_room_id: corner.id,
      message: { authorId: HUMAN, route: { from: { agent: HUMAN, place: corner.id } } },
    });
    expect(resumed.message?.body).toContain('@owner approved once command nous setup');
    const delivered = (await readAgentCommands(fixture.database, AGENT)).commands.find(item => item.id === resumed.id)!;
    expect(delivered.from).toEqual({ agent: HUMAN, place: corner.id });
    const reply = await replyToMessage(fixture.database, AGENT, {
      id: resumed.id, roomId: corner.id,
      text: 'I ran the approved setup. Finish the Nous sign-in or press Ctrl-C in your setup terminal.',
    });
    const stored = (await fixture.database.query<{ room_id: string; card: unknown }>(
      'SELECT room_id,card FROM messages WHERE id=$1', [reply.id],
    )).rows[0]!;
    expect(stored).toMatchObject({ room_id: corner.id, card: {
      route: { from: { agent: AGENT, place: corner.id }, to: { agent: HUMAN, place: corner.id } },
    } });
    expect((await fixture.database.query(
      'SELECT id FROM agent_commands WHERE source_message_id=$1 OR id=$1', [reply.id],
    )).rows).toEqual([]);
  });
});
