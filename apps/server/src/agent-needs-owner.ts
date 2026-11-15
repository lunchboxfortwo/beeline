import { AGENT_SIGN_IN_SERVICE_LABELS } from '@beeline/api-contract/phone';
import { createHash } from 'node:crypto';
import { classifyTurnSilence, isAgentSignInHarness } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, identitySubject, systemLine } from './system-line.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A turn its agent cannot answer until the owner acts. A sign-in is one
 * `agent-sign-in` card carrying the message and its button; the card settles
 * in place, and a sign-in episode ends only when it signs in. A spent
 * allowance is one System line per reset. A repeat of the same episode is the
 * same row, so a retrying agent never stacks them.
 * Returns the card to start once the caller's transaction commits.
 */
export async function noteAgentNeedsOwner(db: SqlDatabase, input: {
  readonly roomId: string;
  readonly agentId: string;
  readonly kind: 'not-signed-in' | 'allowance-spent';
  readonly reason?: string;
}): Promise<{ readonly signInCardId?: string }> {
  const agent = (await db.query<{ name: string; owner_id: string | null; harness: string | null; settled: string | null }>(
    `SELECT identity.name,agent.owner_id,agent.harness,(SELECT card.id FROM messages card
       WHERE card.room_id=$2 AND card.card_type='agent-sign-in' AND card.card->>'agentId'=$1
         AND card.card->>'status'='signed-in' ORDER BY card.created_at DESC,card.id DESC LIMIT 1) settled
     FROM identities identity JOIN agents agent ON agent.agent_id=identity.id
     WHERE identity.id=$1 AND identity.kind='agent'`,
    [input.agentId, input.roomId],
  )).rows[0];
  if (!agent) return {};
  await ensureSystemIdentity(db);
  const subject = identitySubject({ id: input.agentId, kind: 'agent', name: agent.name });
  if (input.kind === 'not-signed-in') {
    // The card's button signs in this harness on the agent's machine.
    if (!agent.owner_id || !isAgentSignInHarness(agent.harness)) return {};
    const id = hash(`agent-needs-sign-in:${input.roomId}:${input.agentId}:${agent.settled ?? ''}`);
    const card = await systemLine(db, {
      id, roomId: input.roomId, authorId: SYSTEM_IDENTITY_ID, subject,
      verb: systemMessage('agent-sign-in.needs-to-sign-in'),
      presentation: 'card', cardType: 'agent-sign-in',
      card: { action: `Sign in to ${AGENT_SIGN_IN_SERVICE_LABELS[agent.harness]}`, agentId: input.agentId, ownerId: agent.owner_id, harness: agent.harness, status: 'starting', sourceMessageId: id },
    });
    if (card.inserted) return { signInCardId: id };
    // The same episode reuses its card: a failed or expired start becomes a fresh button in place.
    const retried = await db.query(`UPDATE messages
      SET card=(card-'errorMessage'-'attemptId'-'authorizeUrl'-'userCode'-'expiresAt'-'kind'-'provider')||'{"status":"starting"}'::jsonb
      WHERE id=$1 AND card_type='agent-sign-in' AND (card->>'status'='failed'
        OR (card->>'status'='pending' AND (card->>'expiresAt')::bigint<(extract(epoch FROM now())*1000)::bigint))`, [id]);
    return retried.rowCount ? { signInCardId: id } : {};
  }
  const until = classifyTurnSilence(input.reason ?? '').allowanceUntil;
  await systemLine(db, {
    id: hash(`agent-out-of-limit:${input.roomId}:${input.agentId}:${until ?? new Date().toISOString().slice(0, 10)}`),
    roomId: input.roomId, authorId: SYSTEM_IDENTITY_ID, subject,
    verb: systemMessage('turn-silence.is-out-of-its-limit'),
    ...(until ? { consequence: systemMessage('turn-silence.resets-at', until) } : {}),
  });
  return {};
}
