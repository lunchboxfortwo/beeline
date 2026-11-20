import type { SqlDatabase } from '../database.js';
import {
  CONNECTOR_RECONNECT_RETIRED,
  OWED_WITHOUT_QUEUED_COMMAND_SQL,
  UNCLAIMED_CONNECTOR_INPUT_SQL,
} from '../rooms-mcp-delivery.js';

/** Queued before the owner chose reconnect retirement (20 Nov 2026, 20:05 UTC). */
const STUCK_CONNECTOR_COMMANDS_BEFORE = '2026-11-20T20:00:00Z';

/**
 * One-time retirement of connector commands left pending, and tags left owed,
 * before reconnect retirement existed. The fixed cutoff makes a second run
 * retire nothing new; nothing is posted and nobody is woken.
 */
export async function retireStuckConnectorCommands(
  database: SqlDatabase,
): Promise<{ commands: number; tags: number }> {
  const retired = await database.query(
    `WITH candidate AS MATERIALIZED (SELECT command.id FROM agent_commands command
       WHERE command.created_at<$1::timestamptz
         AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=command.agent_id)
         AND ${UNCLAIMED_CONNECTOR_INPUT_SQL})
     SELECT ended.id FROM candidate
       CROSS JOIN LATERAL beeline_finish_agent_command(candidate.id,'cancelled',$2,NULL) ended`,
    [STUCK_CONNECTOR_COMMANDS_BEFORE, CONNECTOR_RECONNECT_RETIRED],
  );
  const cleared = await database.query(
    `UPDATE rooms_mcp_mentions mention SET cleared_at=now()
     WHERE mention.cleared_at IS NULL AND mention.created_at<$1::timestamptz
       AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=mention.member_id)
       AND ${OWED_WITHOUT_QUEUED_COMMAND_SQL}`,
    [STUCK_CONNECTOR_COMMANDS_BEFORE],
  );
  const result = { commands: retired.rowCount ?? 0, tags: cleared.rowCount ?? 0 };
  console.log(`retireStuckConnectorCommands: retired ${result.commands} command(s), cleared ${result.tags} tag(s)`);
  return result;
}
