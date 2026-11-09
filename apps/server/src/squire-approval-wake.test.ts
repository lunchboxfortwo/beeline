import { describe, expect, it } from 'vitest';
import { claimAgentCommand, readAgentCommands } from './agent-command.js';
import { monolithFixture, AGENT, ROOM } from './test-fixtures/test-support-monolith.js';

describe('Squire decision after the asking turn ended', () => {
  const fixture = monolithFixture();

  it.each(['approved', 'denied'] as const)(
    'starts one new turn for %s and posts the decision once', async status => {
      const asked = await (await fixture.operation('sendRoomMessage', {
        roomId: ROOM, text: '@bee buy the flowers', mentions: [AGENT],
      })).json() as { messageId: string };
      const [asking] = (await readAgentCommands(fixture.database, ROOM, AGENT)).commands;
      expect(asking).toBeDefined();
      await fixture.database.transaction(tx =>
        claimAgentCommand(tx, ROOM, AGENT, asking!.id, 'asking-generation'));
      await fixture.database.query(
        `SELECT beeline_end_agent_turn(id,generation_id,'complete',NULL,NULL)
         FROM agent_commands WHERE id=$1`, [asking!.id],
      );
      expect((await readAgentCommands(fixture.database, ROOM, AGENT)).commands).toEqual([]);
      const decision = { roomId: ROOM, requestId: asked.messageId, approvalId: 'flowers',
        status, tool: 'inject_card', title: 'Purchase approval', detail: 'Flowers' };
      const first = await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect(first.status).toBe(200);
      const posted = await first.json() as { id: string };
      const duplicate = await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ id: posted.id });
      const { commands } = await readAgentCommands(fixture.database, ROOM, AGENT);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ roomId: ROOM, agentId: AGENT,
        action: 'input', sourceMessageId: posted.id });
      expect(commands[0]!.turnRequestId).not.toBe(asked.messageId);
      expect(commands[0]).toMatchObject({ parentCommandId: asking!.id,
        rootCommandId: asking!.rootCommandId, agentDepth: asking!.agentDepth });
      expect(commands[0]!.source.body).toContain(`Squire approval flowers for inject_card: ${status}`);
      const lines = await fixture.database.query(
        `SELECT id FROM messages WHERE card_type='squire-approval-decision'`,
      );
      expect(lines.rows).toEqual([{ id: posted.id }]);
      await fixture.database.transaction(tx =>
        claimAgentCommand(tx, ROOM, AGENT, commands[0]!.id, 'decision-generation'));
      expect((await fixture.database.query(
        `SELECT request_id,generation_id,status FROM agent_turns WHERE room_id=$1
         AND agent_id=$2 AND request_id=$3`, [ROOM, AGENT, commands[0]!.turnRequestId],
      )).rows).toEqual([{ request_id: posted.id, generation_id: 'decision-generation', status: 'working' }]);
      await fixture.database.query(
        `SELECT beeline_end_agent_turn(id,generation_id,'complete',NULL,NULL)
         FROM agent_commands WHERE id=$1`, [commands[0]!.id],
      );
      await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect((await readAgentCommands(fixture.database, ROOM, AGENT)).commands).toEqual([]);
    },
  );
});
