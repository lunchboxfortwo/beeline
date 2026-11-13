import { createHash } from 'node:crypto';



export const TAGGED_AGENT_LIFECYCLE_COMMANDS = [
  'restart',
  'status',
  'stop',
  'retry',
  'debug',
  'help',
  'login',
] as const;

export type TaggedAgentLifecycleCommand = (typeof TAGGED_AGENT_LIFECYCLE_COMMANDS)[number];


export function parseTaggedAgentLifecycleCommand(
  text: string,
  handle: string | null,
): TaggedAgentLifecycleCommand | undefined {
  if (!handle) return undefined;
  const match = text
    .trim()
    .match(/^@([^\s]+)\s+(?:\/(restart|login)|(restart|status|stop|retry|debug|help|login))$/i);
  if (!match || match[1]!.toLocaleLowerCase() !== handle.toLocaleLowerCase()) return undefined;
  return (match[2] ?? match[3])!.toLocaleLowerCase() as TaggedAgentLifecycleCommand;
}


/** The one sign-in card an `@agent /login` message writes. */
export function agentSignInCardId(sourceMessageId: string, agentId: string): string {
  return createHash('sha256').update(`agent-sign-in:${sourceMessageId}:${agentId}`).digest('hex');
}


/** True for the exact text of an `@agent /login` / `@agent /login` message. */
export function isTaggedLoginText(text: string): boolean {
  return /^@[^\s]+\s+\/?login$/i.test(text.trim());
}


/** The sole agent in a top-level Room with exactly one current human member. */
export function soloRoomAgentSql(room: string, author: string): string {
  return `(SELECT CASE WHEN count(*) FILTER (WHERE solo_identity.kind='agent')=1
      THEN min(member.identity_id) FILTER (WHERE solo_identity.kind='agent')
      ELSE min(member.identity_id) FILTER (WHERE starter.starter_role='beebee') END
    FROM memberships member JOIN identities solo_identity ON solo_identity.id=member.identity_id
    LEFT JOIN free_agents starter ON starter.agent_id=member.identity_id AND starter.owner_id=${author}
      AND starter.removed_at IS NULL
    WHERE member.room_id=${room}.id AND member.removed_at IS NULL
      AND ${room}.parent_id IS NULL AND ${room}.direct_participants IS NULL
    HAVING count(*) FILTER (WHERE solo_identity.kind='human')=1
       AND (count(*) FILTER (WHERE solo_identity.kind='agent')=1 OR
         (count(*) FILTER (WHERE solo_identity.kind='agent')=2
          AND count(*) FILTER (WHERE starter.starter_role IN ('beebee','luna'))=2
          AND count(*) FILTER (WHERE starter.starter_role='beebee')=1))
       AND bool_or(member.identity_id=${author}))`;
}
