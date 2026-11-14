import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';

/** Every terminal write to a queue item goes through this database function:
 * the answer was posted (complete), or Stop cancelled it. A terminal replay
 * changes nothing. Legacy failed outcomes remain readable during upgrades.
 * Nothing else ends an item; a dropped helper leaves it pending.
 */
export const AGENT_TURN_END_SCHEMA = `
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS connection_epoch bigint;
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

-- One terminal projection owns both answered and interrupted executions.
CREATE OR REPLACE FUNCTION beeline_project_agent_turn(
  agent text, room agent_turns.room_id%TYPE, request text, outcome text, reason text,
  before_epoch bigint, expected_start timestamptz, working_only boolean
) RETURNS SETOF agent_turns LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY UPDATE agent_turns turn SET status=outcome,
    failure_reason=CASE WHEN working_only THEN turn.failure_reason ELSE reason END,created_at=clock_timestamp()
    WHERE turn.agent_id=agent AND turn.room_id=room AND turn.request_id=request
      AND (NOT working_only OR turn.status='working')
      AND (before_epoch IS NULL OR turn.connection_epoch IS NULL OR turn.connection_epoch<before_epoch)
      AND (expected_start IS NULL OR turn.started_at=expected_start)
    RETURNING turn.*;
END; $$;

-- Optional projection after publication; this function never completes an item.
CREATE OR REPLACE FUNCTION beeline_record_agent_answer(command_id text, failed boolean, reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE ended agent_commands%ROWTYPE;
BEGIN
  SELECT * INTO ended FROM agent_commands WHERE id=command_id AND state<>'pending';
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM beeline_project_agent_turn(ended.agent_id,ended.room_id,ended.turn_request_id,
    CASE WHEN failed OR ended.report_outcome='failed' THEN 'failed' ELSE ended.state END,reason,NULL,NULL,false);
  DELETE FROM live_outputs WHERE room_id=ended.room_id AND agent_id=ended.agent_id
    AND turn_id=ended.turn_request_id AND kind IN ('draft','thought');
END; $$;

-- An execution may end while its answer is still owed. Connection replacement
-- and a recorded harness exit use this owner without cancelling queue work.
CREATE OR REPLACE FUNCTION beeline_interrupt_agent_turn(
  agent text, room uuid, request text, before_epoch bigint, expected_start timestamptz
) RETURNS SETOF agent_turns LANGUAGE plpgsql AS $$
BEGIN
  PERFORM beeline_finish_agent_command(command.id,'complete',NULL,posted.id)
    FROM agent_commands command JOIN messages posted
      ON posted.id=COALESCE(command.posted_reply_id,command.result_message_id)
      AND posted.author_id=command.agent_id AND posted.room_id=command.return_room_id
      AND posted.deleted_at IS NULL
      AND (posted.request_id=command.turn_request_id OR posted.id=command.result_message_id)
    JOIN agent_turns turn ON turn.agent_id=command.agent_id AND turn.room_id=command.room_id
      AND turn.request_id=command.turn_request_id
    WHERE turn.agent_id=agent AND turn.room_id=room AND turn.request_id=request
      AND turn.status='working' AND command.state='pending'
      AND (before_epoch IS NULL OR turn.connection_epoch IS NULL OR turn.connection_epoch<before_epoch)
      AND (expected_start IS NULL OR turn.started_at=expected_start);
  RETURN QUERY SELECT * FROM beeline_project_agent_turn(agent,room,request,
    COALESCE((SELECT CASE WHEN command.report_outcome='failed' THEN 'failed' ELSE command.state END
      FROM agent_commands command WHERE command.room_id=room AND command.agent_id=agent
        AND command.turn_request_id=request AND command.state<>'pending' LIMIT 1),'cancelled'),
    NULL,before_epoch,expected_start,true);
  DELETE FROM live_outputs output WHERE output.agent_id=agent AND output.room_id=room AND output.turn_id=request
    AND output.kind IN ('draft','thought') AND EXISTS(SELECT 1 FROM agent_turns turn
      WHERE turn.agent_id=agent AND turn.room_id=room AND turn.request_id=request AND turn.status<>'working');
END; $$;

`;

/** Use the recorded replacement epoch to avoid interrupting a newer execution. */
export async function interruptAgentTurns(db: SqlDatabase, agentId: string, beforeEpoch: number): Promise<string[]> {
  const turns = await db.query<{ room_id: string; request_id: string }>(`SELECT room_id,request_id FROM agent_turns
    WHERE agent_id=$1 AND status='working' AND (connection_epoch IS NULL OR connection_epoch<$2)`, [agentId,beforeEpoch]);
  for (const turn of turns.rows) await db.query('SELECT * FROM beeline_interrupt_agent_turn($1,$2,$3,$4,NULL)',
    [agentId,turn.room_id,turn.request_id,beforeEpoch]);
  return [...new Set(turns.rows.map(turn=>turn.room_id))];
}

/** Legacy stop controls are not queue work. Retire any that outlived the queue upgrade. */
export const RETIRED_STOP_CONTROLS = `SELECT beeline_finish_agent_command(id,'cancelled',reason,NULL)
  FROM agent_commands WHERE state='pending' AND action='stop'`;

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
