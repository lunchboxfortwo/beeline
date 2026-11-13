import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';

/** Every terminal write to a queue item goes through this database function:
 * the answer was posted (complete), the agent chose silence (complete), its
 * hosted-model allowance refused it (failed), or Stop/a superseded wake
 * cancelled it. A terminal replay changes nothing.
 * Nothing else ends an item; a dropped helper leaves it pending.
 */
export const AGENT_TURN_END_SCHEMA = `
DROP FUNCTION IF EXISTS beeline_end_agent_turn(text,text,text,text,text);
CREATE OR REPLACE FUNCTION beeline_finish_agent_command(
  command_id text, outcome text, terminal_reason text, result_id text
) RETURNS SETOF agent_commands LANGUAGE plpgsql AS $$
DECLARE ended agent_commands%ROWTYPE;
BEGIN
  IF outcome NOT IN ('complete','failed','cancelled') THEN
    RAISE EXCEPTION 'invalid terminal item outcome';
  END IF;
  UPDATE agent_commands command SET
    state=CASE WHEN outcome='cancelled' THEN 'cancelled' ELSE 'complete' END,completed_at=clock_timestamp(),
    cancellation_reason=CASE WHEN outcome='cancelled' THEN terminal_reason ELSE command.cancellation_reason END,
    result_message_id=COALESCE(result_id,command.result_message_id)
  WHERE command.id=command_id AND command.state='pending'
  RETURNING command.* INTO ended;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agent_turns turn SET status=outcome,failure_reason=terminal_reason,created_at=clock_timestamp()
  WHERE turn.room_id=ended.room_id AND turn.agent_id=ended.agent_id
    AND turn.request_id=ended.turn_request_id AND turn.status='working';
  DELETE FROM live_outputs WHERE room_id=ended.room_id AND agent_id=ended.agent_id
    AND turn_id=ended.turn_request_id AND kind IN ('draft','thought');
  RETURN NEXT ended;
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
