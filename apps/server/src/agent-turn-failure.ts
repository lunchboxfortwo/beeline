import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { commanderReportAddress, reportToCommander } from './commander.js';
import { systemLine } from './system-line.js';

/** Called only after the terminal owner accepted an explicit failed result.
 * A lost connection never creates a notice or a second assignment.
 */
export async function recordAgentTurnFailure(db: SqlDatabase, command: CommandRow, reason: string | null): Promise<boolean> {
  const room = (await db.query<{name:string;parent_id:string|null}>(
    'SELECT name,parent_id FROM rooms WHERE id=$1',[command.room_id])).rows[0];
  const agent = (await db.query<{ name: string; handle:string|null }>(
    'SELECT name,beeline_room_handle(id,$2) handle FROM identities WHERE id=$1',
    [command.agent_id,command.room_id])).rows[0];
  // A batch may contain orders from different issuers. Group failures by
  // their resolved recipient and return place, never by the batch alone.
  const route = await commanderReportAddress(db, command.room_id, command, true);
  const failures = (await db.query<CommandRow & { invocation:string; sibling:boolean }>(`
    SELECT source.*,
      jsonb_build_array(COALESCE(turn.generation_id,turn.request_id),source.claimed_at)::text invocation,
      ($3::text IS NOT NULL AND turn.generation_id=$3 AND source.id<>current.id
        AND source.claimed_at=current.claimed_at AND current.claimed_at IS NOT NULL) sibling
    FROM agent_turns turn JOIN agent_commands source ON source.room_id=turn.room_id
      AND source.agent_id=turn.agent_id AND source.turn_request_id=turn.request_id
      AND source.generation_id IS NOT DISTINCT FROM turn.generation_id
    CROSS JOIN agent_commands current
    WHERE current.id=$4 AND turn.room_id=$1 AND turn.agent_id=$2 AND turn.status='failed'
      AND turn.created_at>COALESCE((SELECT max(success.created_at) FROM agent_turns success
        WHERE success.room_id=$1 AND success.agent_id=$2 AND success.status='complete'),'-infinity'::timestamptz)
    ORDER BY turn.created_at DESC,source.id`,
    [command.room_id,command.agent_id,command.generation_id,command.id])).rows;
  const invocations = new Set<string>();
  const streak = {count:0,sibling:false};
  for (const failure of failures) {
    const previousRoute = failure.id === command.id ? route :
      await commanderReportAddress(db, command.room_id, failure, true);
    if (previousRoute.recipient !== route.recipient || previousRoute.returnRoom !== route.returnRoom) continue;
    invocations.add(failure.invocation);
    streak.sibling ||= failure.sibling;
    streak.count = invocations.size;
    if (streak.count > 2) break;
  }
  if (streak.sibling) return false;
  let delivered = false;
  if (streak.count <= 2 && (command.private_payload?.kind === 'order' || command.review_context || room?.parent_id)) {
    const report = await reportToCommander(db, command.room_id, command.agent_id,
      `failed: @${agent?.handle ?? agent?.name ?? command.agent_id} in ${room?.name ?? 'Room'} (${command.room_id}): ${reason || 'I could not finish this request.'}` +
        (streak.count === 2 ? ' (repeated failures; further failures stay visible in the place until a turn succeeds)' : ''),
      command, `failure:${command.id}`, {automatic:true,orderIssuer:true});
    delivered = report.delivered !== false;
  }
  await systemLine(db, {
    roomId: command.room_id,
    subject: { kind: 'agent', id: command.agent_id, name: agent?.name ?? 'Agent' },
    verb: 'could not finish this request',
    ...(reason ? {consequence:reason} : {}),
    cardType: 'turn-failed', card: { requestId: command.turn_request_id, agentId: command.agent_id, state: 'failed' },
    afterMessageId: command.source_message_id ?? undefined,
  });
  return delivered;
}
