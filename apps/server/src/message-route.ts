import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { threadCommanderAddressSql } from './corner-commander.js';
import type { MessageAddress, MessageRoute } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { legacyMessageRoute } from './messaging-cutover.js';

/** Current messages carry their whole route. Only retained pre-cutover items need adaptation. */
export async function recordedMessageRoute(db:SqlDatabase,item:CommandRow):Promise<MessageRoute> {
  const route=item.message?.route ?? item.private_payload?.route;
  if (route) return {...route,from:item.message?.replyAddress ?? item.private_payload?.replyAddress ?? route.from};
  return legacyMessageRoute(db,item);
}

/** Reports follow the session's recorded chain of command. */
export async function reportRecipient(db:SqlDatabase,item:CommandRow):Promise<MessageAddress> {
  const address = (await recordedMessageRoute(db,item)).from;
  const sender = item.message?.route?.from ?? item.private_payload?.route?.from ?? address;
  // A system wake (a Sentry alert) records who it answers; that is the issuer, not the System.
  const issuer = sender.agent === SYSTEM_IDENTITY_ID ? address : sender;
  const thread = (await db.query<{address:MessageAddress|null}>(`SELECT CASE
    WHEN room.id::text=$3 AND $2<>'${SYSTEM_IDENTITY_ID}' AND EXISTS(SELECT 1 FROM identities WHERE id=$2 AND kind='human')
      THEN jsonb_build_object('agent',$2::text,'place',room.id)
    ELSE COALESCE(${threadCommanderAddressSql('room.id')},jsonb_build_object('agent',room.created_by,'place',room.parent_id)) END address
    FROM rooms room JOIN rooms parent ON parent.id=room.parent_id
    WHERE room.id=$1`,[item.room_id,issuer.agent,issuer.place])).rows[0];
  return thread?.address ?? (address.agent === SYSTEM_IDENTITY_ID ? {...address,place:item.room_id} : address);
}

/** Read the same root requester that cancelAgentTurn authorizes, including relayed turns. */
export function turnRootMessageSql(turn: 'turn' | 'written'): string {
  return `COALESCE((SELECT command.root_source_message_id FROM agent_commands command
    WHERE command.room_id=${turn}.room_id AND command.agent_id=${turn}.agent_id
      AND command.turn_request_id=${turn}.request_id
    ORDER BY command.created_at DESC,command.id DESC LIMIT 1),${turn}.request_id)`;
}
