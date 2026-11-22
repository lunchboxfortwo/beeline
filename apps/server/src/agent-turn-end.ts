import { createHash } from 'node:crypto';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { systemLine } from './system-line.js';

/** Every terminal write to a queue item goes through this database function:
 * the answer was posted (complete), or Stop cancelled it. A terminal replay
 * changes nothing. Legacy failed outcomes remain readable during upgrades.
 * Nothing else ends an item; a dropped helper leaves it pending.
 */
export const AGENT_TURN_END_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_invocations (
  command_id text NOT NULL REFERENCES agent_commands(id) ON DELETE CASCADE,
  invocation_id text NOT NULL,
  replied boolean NOT NULL DEFAULT false,
  final_suppressed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(command_id,invocation_id)
);
ALTER TABLE agent_invocations ADD COLUMN IF NOT EXISTS ended boolean NOT NULL DEFAULT false;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS connection_epoch bigint;
-- Stop after the reply: the item is complete but its run is still open.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_commands_stop_requested ON agent_commands(agent_id)
  WHERE stop_requested_at IS NOT NULL AND state='complete';
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS invocation_id text;
-- Lifecycle projections may finish their reads in a different order. Keep a
-- revision even when two executions start in one second. The constant column
-- default avoids rewriting turn history during rollout; new writes use the
-- sequence so different requests for an agent are comparable too.
CREATE SEQUENCE IF NOT EXISTS agent_turns_version_seq;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION agent_turns_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := nextval('agent_turns_version_seq');
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS agent_turns_bump_version ON agent_turns;
CREATE TRIGGER agent_turns_bump_version BEFORE INSERT OR UPDATE ON agent_turns
  FOR EACH ROW EXECUTE FUNCTION agent_turns_bump_version();
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
-- The working line ends with the item, even while the agent's run continues.
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

-- Stop after the reply: the item is already complete, so the line and the
-- still-open run are what remain. End the working line now and record the
-- request so the agent's helper cancels that run (daemon-live.ts).
CREATE OR REPLACE FUNCTION beeline_stop_answered_agent_turn(command_id text)
RETURNS SETOF agent_turns LANGUAGE plpgsql AS $$
DECLARE answered agent_commands%ROWTYPE;
BEGIN
  SELECT * INTO answered FROM agent_commands WHERE id=command_id AND state='complete';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agent_commands stopped SET stop_requested_at=clock_timestamp() WHERE stopped.id=answered.id
    AND EXISTS(SELECT 1 FROM agent_invocations invocation WHERE invocation.command_id=answered.id AND NOT invocation.ended);
  RETURN QUERY SELECT * FROM beeline_project_agent_turn(answered.agent_id,answered.room_id,answered.turn_request_id,
    'cancelled',NULL,NULL,NULL,true);
  DELETE FROM live_outputs output WHERE output.room_id=answered.room_id AND output.agent_id=answered.agent_id
    AND output.turn_id=answered.turn_request_id AND output.kind IN ('draft','thought');
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

/** Cancellation reason of a turn a person stopped; an agent's stop keeps 'stop'. */
export const PERSON_STOP_REASON = 'person_stop';

/** Use the recorded replacement epoch to avoid interrupting a newer execution. */
export async function interruptAgentTurns(db: SqlDatabase, agentId: string, beforeEpoch: number, offline = false): Promise<string[]> {
  const turns = await db.query<{ room_id: string; request_id: string }>(`SELECT room_id,request_id FROM agent_turns
    WHERE agent_id=$1 AND status='working' AND (connection_epoch IS NULL OR connection_epoch<$2)`, [agentId,beforeEpoch]);
  for (const turn of turns.rows) {
    const ended = await db.query('SELECT * FROM beeline_interrupt_agent_turn($1,$2,$3,$4,NULL)',
      [agentId,turn.room_id,turn.request_id,beforeEpoch]);
    if (offline && ended.rowCount) {
      const agent = (await db.query<{ name: string }>('SELECT name FROM identities WHERE id=$1', [agentId])).rows[0]!;
      await systemLine(db, {
        id: createHash('sha256').update(`host-offline:${agentId}:${turn.request_id}:${beforeEpoch}`).digest('hex'),
        roomId: turn.room_id, subject: { kind: 'agent', id: agentId, name: agent.name },
        verb: systemMessage('agent-turn.host-offline'), requestId: turn.request_id, routeCommands: false,
      });
    }
  }
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

/** Stop on a working line whose item was already answered. False when no line was working. */
export async function stopAnsweredAgentTurn(db: SqlDatabase, command: Pick<CommandRow, 'id'>): Promise<boolean> {
  const ended = await db.query('SELECT * FROM beeline_stop_answered_agent_turn($1)', [command.id]);
  return ended.rowCount > 0;
}

/** Answered items whose run a person stopped; the helper cancels a run it still has. */
export async function stoppedAnsweredCommandIds(db: SqlDatabase, agentId: string): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT command.id FROM agent_commands command
    WHERE command.agent_id=$1 AND command.stop_requested_at IS NOT NULL AND command.state='complete'
      AND EXISTS(SELECT 1 FROM agent_invocations invocation WHERE invocation.command_id=command.id AND NOT invocation.ended)`,
    [agentId])).rows.map(row => row.id);
}

/** A hosted turn that fails ends with its visible System line and reason. */
export async function failHostedAgentTurn(db: SqlDatabase,
  command: Pick<CommandRow, 'id' | 'room_id' | 'return_room_id' | 'turn_request_id'>, agentId: string, reason: string): Promise<boolean> {
  if (!await endAgentTurn(db, command, 'failed', reason)) return false;
  await db.query('SELECT beeline_record_agent_answer($1,true,$2)', [command.id, reason]);
  const agent = (await db.query<{ name: string }>('SELECT name FROM identities WHERE id=$1', [agentId])).rows[0]!;
  await systemLine(db, {
    id: createHash('sha256').update(`failed:${command.id}`).digest('hex'),
    roomId: command.return_room_id ?? command.room_id,
    subject: { kind: 'agent', id: agentId, name: agent.name },
    verb: systemMessage('agent-turn.failed'),
    consequence: systemMessage('agent-turn.failure-reason', reason),
    requestId: command.turn_request_id, commandId: command.id, durableFact: 'failure',
  });
  return true;
}

/** The execution record owns working independently of answer delivery. */
export function workingTurnFreshSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid turn SQL alias');
  return `${alias}.status='working'`;
}
