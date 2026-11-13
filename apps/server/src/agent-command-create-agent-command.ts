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
