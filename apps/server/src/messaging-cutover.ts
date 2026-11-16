import type { MessageAddress, MessageRoute } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { CommandRow,PrivateCommandPayload } from './agent-command.js';
import type { SqlDatabase } from './database.js';

/** MESSAGING CUTOVER REMOVAL POINT.
 * Delete this adapter and the legacy order/report daemon routes once no legacy
 * queued or in-flight item remains. At that same removal:
 * - remove the legacy-only wake-place, snapshot and status branches in agent-command.ts;
 * - remove sendOrder/reportToCommander and ancestor routing in commander.ts;
 * - remove legacy report wait/card selectors, keeping messageAsksSql;
 * - remove askOwnerQuestion and the order/report/mergeCorner daemon compatibility operations.
 * Phone work-detail writes are separate supported client operations.
 * New message/reply tools never acquire legacy routing.
 * Remove the legacyCommandPayload guard in insertAgentCommand, the report/status
 * answer branch in answerQueuedMessage, legacy commander/report feeder SQL, and
 * the old operation contracts/routes in that same post-drain change.
 * Stored sender and place win; history never selects a new commander.
 */
export async function legacyMessageRoute(db: SqlDatabase, item: CommandRow): Promise<MessageRoute> {
  const source = item.source_message_id ? (await db.query<{author_id:string;room_id:string;system_event:unknown}>(
    'SELECT author_id,room_id,system_event FROM messages WHERE id=$1',[item.source_message_id])).rows[0] : undefined;
  const payload = item.private_payload;
  let from: MessageAddress = {
    agent:payload?.authorId ?? source?.author_id ?? SYSTEM_IDENTITY_ID,
    place:payload?.fromRoomId ?? source?.room_id ?? item.room_id,
  };
  if (from.agent===SYSTEM_IDENTITY_ID || source?.system_event) {
    if (item.report_address) from={agent:item.report_address.identityId,place:item.report_address.roomId};
    else if (payload?.returnIdentityId) from={agent:payload.returnIdentityId,place:item.return_room_id ?? item.room_id};
  }
  return {from,to:{agent:item.agent_id,place:item.room_id}};
}

/** Calls from serving old helper builds remain old queue plumbing until drain. */
export function legacyCommandPayload(payload:PrivateCommandPayload|undefined):boolean {
  return Boolean(payload && ['order','report'].includes(payload.kind) && !payload.route);
}

/** A queued old landing wake cannot ask a new helper to call a removed tool. */
export function legacyMessageBody(item:Pick<CommandRow,'reason'> & {private_payload?:{authorId:string}|null},body:string,sender=item.private_payload?.authorId):string {
  return item.reason==='corner_land' && sender===SYSTEM_IDENTITY_ID
    ? 'The server merges eligible pull requests. This queued landing wake needs no agent merge action.' : body;
}
