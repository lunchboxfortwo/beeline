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
