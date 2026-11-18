import type { MessageRoute } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { legacyMessageRoute } from './messaging-cutover.js';

/** Current messages carry their whole route. Only retained pre-cutover items need adaptation. */
export async function recordedMessageRoute(db:SqlDatabase,item:CommandRow):Promise<MessageRoute> {
  const route=item.message?.route ?? item.private_payload?.route;
  if (route) return {...route,from:item.message?.replyAddress ?? item.private_payload?.replyAddress ?? route.from};
  return legacyMessageRoute(db,item);
}

/** Read the same root requester that cancelAgentTurn authorizes, including relayed turns. */
export function turnRootMessageSql(turn: 'turn' | 'written'): string {
  return `COALESCE((SELECT command.root_source_message_id FROM agent_commands command
    WHERE command.room_id=${turn}.room_id AND command.agent_id=${turn}.agent_id
      AND command.turn_request_id=${turn}.request_id
    ORDER BY command.created_at DESC,command.id DESC LIMIT 1),${turn}.request_id)`;
}
