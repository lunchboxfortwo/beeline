import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';

/** Every terminal write to a queue item goes through this database function:
 * the answer was posted (complete), or Stop cancelled it. A terminal replay
 * changes nothing. Legacy failed outcomes remain readable during upgrades.
 * Nothing else ends an item; a dropped helper leaves it pending.
 */
export const AGENT_TURN_END_SCHEMA = `
CREATE OR REPLACE FUNCTION beeline_finish_agent_command(
  command_id text, outcome text, terminal_reason text, result_id text
) RETURNS SETOF agent_commands LANGUAGE plpgsql AS $$
DECLARE ended agent_commands%ROWTYPE;
BEGIN
  IF outcome NOT IN ('complete','failed','cancelled') THEN
    RAISE EXCEPTION 'invalid terminal item outcome';
  END IF;
  UPDATE agent_commands command SET
    report_outcome=outcome,state=CASE WHEN outcome='cancelled' THEN 'cancelled' ELSE 'complete' END,completed_at=clock_timestamp(),
    cancellation_reason=CASE WHEN outcome='cancelled' THEN terminal_reason ELSE command.cancellation_reason END,
    result_message_id=COALESCE(result_id,command.result_message_id)
  WHERE command.id=command_id AND command.state='pending'
  RETURNING command.* INTO ended;
  IF NOT FOUND THEN RETURN; END IF;
  IF outcome='cancelled' THEN
    PERFORM beeline_record_agent_answer(ended.id,false,terminal_reason);
  END IF;
  RETURN NEXT ended;
END; $$;

-- Optional projection after publication; this function never completes an item.
CREATE OR REPLACE FUNCTION beeline_record_agent_answer(command_id text, failed boolean, reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE ended agent_commands%ROWTYPE;
BEGIN
  SELECT * INTO ended FROM agent_commands WHERE id=command_id AND state<>'pending';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agent_turns turn SET status=CASE WHEN failed OR ended.report_outcome='failed' THEN 'failed' ELSE ended.state END,
    failure_reason=reason,created_at=clock_timestamp()
  WHERE turn.room_id=ended.room_id AND turn.agent_id=ended.agent_id AND turn.request_id=ended.turn_request_id;
  DELETE FROM live_outputs WHERE room_id=ended.room_id AND agent_id=ended.agent_id
    AND turn_id=ended.turn_request_id AND kind IN ('draft','thought');
END; $$;

`;

/** Use within the caller's transaction. A terminal replay is a no-op. */
export async function endAgentTurn(db: SqlDatabase, command: Pick<CommandRow, 'id'>,
  outcome: 'complete' | 'failed' | 'cancelled', reason?: string | null, resultMessageId?: string): Promise<boolean> {
  const ended = await db.query('SELECT * FROM beeline_finish_agent_command($1,$2,$3,$4)',
    [command.id, outcome, reason ?? null, resultMessageId ?? null]);
  return ended.rowCount > 0;
}

/** A turn is working only while its queue item is still pending. */
export function workingTurnFreshSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid turn SQL alias');
  return `EXISTS(SELECT 1 FROM agent_commands working_command
    WHERE working_command.room_id=${alias}.room_id AND working_command.agent_id=${alias}.agent_id
      AND working_command.turn_request_id=${alias}.request_id AND working_command.state='pending')`;
}
