import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { describe, expect, it } from 'vitest';
import { readAgentCommands } from './agent-command.js';
import { monolithFixture, AGENT, ROOM } from './test-fixtures/test-support-monolith.js';

describe('Squire decision after the asking turn ended', () => {
  const fixture = monolithFixture();

  it.each([['approved', true], ['denied', true], ['approved', false], ['denied', false]] as const)(
    'handles %s with asking turn ended=%s silently', async (status, ended) => {
      await (await fixture.operation('sendRoomMessage', {
        roomId: ROOM, text: '@bee buy the flowers', mentions: [AGENT],
      })).json() as { messageId: string };
      const [asking] = (await readAgentCommands(fixture.database, AGENT, ROOM)).commands;
      expect(asking).toBeDefined();
      await fixture.database.transaction(tx =>
        startQueuedTurn(tx, ROOM, AGENT, asking!.id));
      if (ended) await fixture.database.query(
        `SELECT beeline_finish_agent_command(id,'complete',NULL,NULL)
         FROM agent_commands WHERE id=$1`, [asking!.id],
      );
      if (ended) expect((await readAgentCommands(fixture.database, AGENT, ROOM)).commands).toEqual([]);
      const decision = { roomId: ROOM, requestId: asking!.turnRequestId, approvalId: 'flowers',
        status, tool: 'inject_card', title: 'Purchase approval', detail: 'Flowers' };
      const first = await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect(first.status).toBe(200);
      const posted = await first.json() as { id: string };
      const duplicate = await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ id: posted.id });
      const waiting = async () => (await readAgentCommands(fixture.database, AGENT, ROOM)).commands.filter(command => command.sourceMessageId === posted.id);
      const commands = await waiting();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ roomId: ROOM, agentId: AGENT,
        action: 'input', sourceMessageId: posted.id });
      expect(commands[0]!.turnRequestId).toBe(commands[0]!.id);
      expect(commands[0]!.turnRequestId).not.toBe(asking!.turnRequestId);
      expect(commands[0]).toMatchObject({ parentCommandId: asking!.id,
        rootCommandId: asking!.rootCommandId, agentDepth: asking!.agentDepth });
      expect(commands[0]!.source.body).toContain(`Squire approval flowers for inject_card: ${status}`);
      const lines = await fixture.database.query(
        `SELECT id FROM messages WHERE card_type='squire-approval-decision'`,
      );
      expect(lines.rows).toEqual([{ id: posted.id }]);
      await fixture.database.transaction(tx =>
        startQueuedTurn(tx, ROOM, AGENT, commands[0]!.id));
      expect((await fixture.database.query(
        `SELECT request_id,status FROM agent_turns WHERE room_id=$1
         AND agent_id=$2 AND request_id=$3`, [ROOM, AGENT, commands[0]!.turnRequestId],
      )).rows).toEqual([{ request_id: commands[0]!.turnRequestId, status: 'working' }]);
      const silent = await fixture.daemonOperation('markAgentTurnSilent', { roomId: ROOM, requestId: commands[0]!.turnRequestId });
      expect(silent.status).toBe(200);
      expect(await waiting()).toHaveLength(1);
      expect((await fixture.daemonOperation('postRoomMessage', { roomId: ROOM, requestId: commands[0]!.id, text: 'I have the decision.' })).status).toBe(200);
      await fixture.daemonOperation('postSquireApprovalDecision', decision);
      expect(await waiting()).toEqual([]);
    },
  );
});
