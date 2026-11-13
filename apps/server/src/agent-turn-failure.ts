import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { commanderReportAddress, reportToCommander } from './commander.js';

/** An item its hosted-model allowance refused tells its commanding agent once. */
export async function recordAgentTurnFailure(db: SqlDatabase, command: CommandRow, reason: string | null): Promise<boolean> {
  const room = (await db.query<{name:string;parent_id:string|null}>(
    'SELECT name,parent_id FROM rooms WHERE id=$1',[command.room_id])).rows[0];
  const agent = (await db.query<{ name: string; handle:string|null }>(
    'SELECT name,beeline_room_handle(id,$2) handle FROM identities WHERE id=$1',
    [command.agent_id,command.room_id])).rows[0];
  const route = await commanderReportAddress(db, command.room_id, command, true);
  if (!route.recipient) return false;
  const recipient = (await db.query<{kind:string}>('SELECT kind FROM identities WHERE id=$1', [route.recipient])).rows[0];
  if (recipient?.kind !== 'agent') return false;
  if (command.private_payload?.kind !== 'order' && !command.review_context && !room?.parent_id) return false;
  const report = await reportToCommander(db, command.room_id, command.agent_id,
    `failed: @${agent?.handle ?? agent?.name ?? command.agent_id} in ${room?.name ?? 'Room'} (${command.room_id}): ${reason || 'I could not finish this request.'}`,
    command, `failure:${command.id}`, {automatic:true,orderIssuer:true});
  return report.delivered !== false;
}
