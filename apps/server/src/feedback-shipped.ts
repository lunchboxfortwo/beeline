import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { SqlDatabase } from './database.js';
import type { FeedbackLoop } from './feedback.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

type ShippedItem = {
  id: string;
  reporter_identity_id: string;
  room_id: string | null;
  triage_reason: string | null;
  occurrences: unknown;
};

type ShippedRelease = { readonly version: string; readonly sha: string };

/**
 * The release step closes the loop for agent reports. Each resolved agent item
 * links its fixing pull request (`notifyFeedbackFixed`). Once a delivered
 * release contains that merge, every agent that reported the problem gets one
 * passive System line in the Room where it last reported it, and the items
 * record `resolved_notified_at` so a later delivery sends nothing again.
 * A failed GitHub read leaves that pull request for the next release.
 */
export async function notifyFeedbackShipped(
  database: SqlDatabase,
  { config, pullRequests }: FeedbackLoop,
  release: ShippedRelease,
): Promise<number> {
  if (!pullRequests) return 0;
  const pending = await database.query<{ issue_number: number }>(
    `SELECT DISTINCT issue_number FROM feedback_items
     WHERE source_kind='agent' AND status='resolved' AND resolved_notified_at IS NULL
       AND issue_number IS NOT NULL AND lower(issue_repository)=lower($1)
     ORDER BY issue_number`,
    [config.repository],
  );
  let notified = 0;
  for (const { issue_number: number } of pending.rows) {
    let shipped: boolean;
    try {
      shipped = await pullRequests.shipped(config.repository, number, release.sha);
    } catch (error) {
      console.error(
        `[feedback] could not check pull request ${number} against ${release.version}`,
        error,
      );
      continue;
    }
    if (shipped)
      notified += await database.transaction((db) =>
        tellReporters(db, config.repository, number, release.version),
      );
  }
  return notified;
}

/** The fix title `notifyFeedbackFixed` stored as the item's triage reason. */
function fixTitle(reason: string | null): string | undefined {
  try {
    const parsed = JSON.parse(reason ?? '') as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

async function tellReporters(
  db: SqlDatabase,
  repository: string,
  number: number,
  version: string,
): Promise<number> {
  const items = (
    await db.query<ShippedItem>(
      `SELECT id,reporter_identity_id,room_id,triage_reason,occurrences FROM feedback_items
       WHERE source_kind='agent' AND status='resolved' AND resolved_notified_at IS NULL
         AND issue_number=$2 AND lower(issue_repository)=lower($1)
       ORDER BY created_at,id FOR UPDATE`,
      [repository, number],
    )
  ).rows;
  if (!items.length) return 0;
  // Each reporting agent, with the Room of its latest report of this problem.
  const reporters = new Map<string, string | null>();
  for (const item of items) {
    reporters.set(item.reporter_identity_id, item.room_id);
    for (const occurrence of Array.isArray(item.occurrences) ? item.occurrences : []) {
      const { agentId, roomId } = (occurrence ?? {}) as { agentId?: unknown; roomId?: unknown };
      if (typeof agentId === 'string')
        reporters.set(agentId, typeof roomId === 'string' ? roomId : item.room_id);
    }
  }
  const live = await db.query<{ id: string }>(
    `SELECT identity.id FROM identities identity WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'`,
    [[...reporters.keys()]],
  );
  const rooms = new Set(
    (
      await db.query<{ id: string }>(`SELECT id FROM rooms WHERE id::text=ANY($1::text[])`, [
        [...new Set([...reporters.values()].filter((id): id is string => Boolean(id)))],
      ])
    ).rows.map((row) => row.id),
  );
  const title = fixTitle(items[0]!.triage_reason);
  const url = systemMessage('feedback.https-github-com-pull', repository, number);
  let notified = 0;
  if (live.rowCount) await ensureSystemIdentity(db);
  for (const { id: agentId } of live.rows) {
    const roomId = reporters.get(agentId);
    if (!roomId || !rooms.has(roomId)) continue;
    const line = await systemLine(db, {
      id: createHash('sha256')
        .update(`beeline-feedback-shipped:v1:${url.toLowerCase()}:${agentId}`)
        .digest('hex'),
      roomId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'agent', id: agentId, name: agentId },
      verb: systemMessage('feedback.shipped'),
      object: version,
      consequence: [title, url].filter(Boolean).join(' '),
      // Passive and unrouted: it informs the agent and wakes nobody.
      cardType: 'feedback-shipped',
      routeCommands: false,
    });
    if (line.inserted) notified++;
  }
  await db.query(`UPDATE feedback_items SET resolved_notified_at=now() WHERE id=ANY($1::text[])`, [
    items.map((item) => item.id),
  ]);
  return notified;
}
