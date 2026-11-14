import {
  AGENT_PRESENCE_DORMANT_MS,
  AGENT_PRESENCE_STALE_MS,
  newerAgentPresence,
  resolveAgentPresenceTier,
  type AgentPresence,
  type AgentPresenceTier,
  type RoomViewAgentTurn,
} from '@beeline/buzz-client';

export type RoomAgentPresence = AgentPresence & { generationId?: string };

/**
 * One tier answer for every surface. Thin over the canonical SDK door so all
 * consumers share the same invariants; kept here because mobile resolves the
 * SDK through its built `dist/` and every screen already imports this module.
 */
export function agentPresenceTier(
  presence: AgentPresence | undefined,
  now = Date.now(),
): AgentPresenceTier {
  return resolveAgentPresenceTier(presence, now);
}

export function nextAgentPresenceTransitionAt(
  presences: Readonly<Record<string, RoomAgentPresence | AgentPresence>>,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  for (const presence of Object.values(presences)) {
    const observedAt = presence.observedAt * 1_000;
    const deadlines = [
      ...(presence.status === 'online' && !presence.held ? [observedAt + AGENT_PRESENCE_STALE_MS] : []),
      observedAt + AGENT_PRESENCE_DORMANT_MS,
    ];
    for (const deadline of deadlines) {
      if (!Number.isFinite(deadline) || deadline <= now) continue;
      next = next === undefined ? deadline : Math.min(next, deadline);
    }
  }
  return next;
}

/** Working/terminal state comes from committed server lifecycle projections. */
export function isAgentTurnActive(turn: RoomViewAgentTurn): boolean {
  return turn.status === 'working';
}

export function mergeAgentPresence(
  current: Readonly<Record<string, RoomAgentPresence>>,
  incoming: RoomAgentPresence,
): Record<string, RoomAgentPresence> {
  const next = newerAgentPresence(current[incoming.agentPubkey], incoming);
  if (next === current[incoming.agentPubkey]) return current as Record<string, RoomAgentPresence>;
  return { ...current, [incoming.agentPubkey]: next };
}

/** A server refetch may race a newer availability transition; newest time wins. */
export function mergeAgentPresenceBatch(
  current: Readonly<Record<string, RoomAgentPresence>>,
  incoming: readonly RoomAgentPresence[],
): Record<string, RoomAgentPresence> {
  return incoming.reduce(mergeAgentPresence, current as Record<string, RoomAgentPresence>);
}
