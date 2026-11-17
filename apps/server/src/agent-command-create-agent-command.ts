import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { CornerAccessDatabase } from './corner-access-database.js';
import { AGENT_SIGN_IN_SERVICE_LABELS, agentSignInUsesKey, isAgentSignInHarness } from '@beeline/api-contract/daemon';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemIdentity, systemLine } from './system-line.js';
import type { AgentCommandInput, CommandRow } from './agent-command.js';



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


/** True for the exact text of an `@agent /login` / `@agent login` message. */
export function isTaggedLoginText(text: string): boolean {
  return /^@[^\s]+\s+\/?login$/i.test(text.trim());
}


type LifecycleTarget = {
  agent_id: string;
  owner_id: string;
  harness: string | null;
  handle: string | null;
  name: string;
};


export async function routeTaggedLifecycleCommand(
  db: SqlDatabase,
  source: { room_id: string; author_id: string; text: string; tagged_ids: string[] },
  sourceId: string,
  append: (input: AgentCommandInput, retry?: CommandRow) => Promise<CommandRow | undefined>,
): Promise<boolean> {
  db = new CornerAccessDatabase(db);
  if (
    source.tagged_ids.length !== 1 ||
    !/^@[^\s]+\s+(?:\/(?:restart|login)|restart|retry|login)$/i.test(
      source.text.trim(),
    )
  )
    return false;
  const target = (
    await db.query<LifecycleTarget>(
      `SELECT agent.agent_id,agent.owner_id,agent.harness,
         beeline_workspace_handle(identity.id,target_member.workspace_id) handle,identity.name
       FROM agents agent
       JOIN identities identity ON identity.id=agent.agent_id
       JOIN room_access target_member ON target_member.room_id=$2
         AND target_member.identity_id=agent.agent_id AND target_member.removed_at IS NULL
       JOIN room_access sender ON sender.room_id=$2
         AND sender.identity_id=$3 AND sender.removed_at IS NULL
       WHERE agent.agent_id=$1
         AND NOT EXISTS(SELECT 1 FROM rooms_mcp_members WHERE member_id=agent.agent_id)
       FOR SHARE OF agent`,
      [source.tagged_ids[0], source.room_id, source.author_id],
    )
  ).rows[0];
  if (!target) return false;
  const action = parseTaggedAgentLifecycleCommand(source.text, target.handle);
  if (action !== 'login' && action !== 'restart' && action !== 'retry') return false;

  // Lifecycle controls belong to current members, independently of the work
  // access policy. Sign-in stays with the agent's owner; Stop uses the ingress's
  // existing cancellation path. Status, debug and help remain ordinary requests.
  const ownsAgent = target.owner_id === source.author_id;
  const loginHarness = isAgentSignInHarness(target.harness) ? target.harness : undefined;
  if (action === 'login') {
    // Claude Code's own `/login`, at the call site, for every harness: the
    // card carries what the machine answers (a link, a device code, or a key
    // field) once `beginAgentSignInCards` asks after this transaction commits.
    // A code or key is pasted into the card, never sent as a message.
    if (!ownsAgent) {
      return true;
    }
    const harness = loginHarness;
    if (!harness) {
      return true;
    }
    await ensureSystemIdentity(db);
    await systemLine(db, {
      id: agentSignInCardId(sourceId, target.agent_id),
      roomId: source.room_id,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'agent', id: target.agent_id, name: target.name },
      verb: systemMessage('agent-sign-in.needs-to-sign-in'),
      afterMessageId: sourceId,
      presentation: 'card',
      cardType: 'agent-sign-in',
      card: {
        action: `${agentSignInUsesKey(harness) ? 'Set key for' : 'Sign in to'} ${AGENT_SIGN_IN_SERVICE_LABELS[harness]}`,
        agentId: target.agent_id,
        ownerId: target.owner_id,
        harness,
        status: 'starting',
        sourceMessageId: sourceId,
      },
    });
    return true;
  }

  if (action === 'retry') {
    const failed = (
      await db.query<CommandRow>(
        `SELECT command.* FROM agent_commands command
         JOIN agent_turns turn ON turn.room_id=command.room_id
           AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
         WHERE command.room_id=$1 AND command.agent_id=$2
           AND command.action='input' AND turn.status='failed'
         ORDER BY turn.created_at DESC,command.created_at DESC LIMIT 1 FOR UPDATE OF command`,
        [source.room_id, target.agent_id],
      )
    ).rows[0];
    if (!failed) {
      return true;
    }
    await append({
      roomId: source.room_id,
      agentId: target.agent_id,
      sourceMessageId: sourceId,
      privatePayload: failed.private_payload ?? undefined,
      reason: 'tagged_lifecycle_retry',
      parent: failed,
      retainDepth: true,
    }, failed);
    return true;
  }

  await append({
    roomId: source.room_id,
    agentId: target.agent_id,
    sourceMessageId: sourceId,
    action: 'restart',
    reason: 'tagged_lifecycle_restart',
  });
  return true;
}
