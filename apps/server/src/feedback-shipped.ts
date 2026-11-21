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
  source_kind: string;
  created_at: Date;
  occurrences: unknown;
};

type ShippedRelease = { readonly version: string; readonly sha: string };

export async function notifyFeedbackShipped(
  database: SqlDatabase,
  { config, pullRequests }: FeedbackLoop,
  release: ShippedRelease,
): Promise<number> {
  if (!pullRequests) return 0;
  const pending = await database.query<{ issue_number: number }>(
    `SELECT DISTINCT issue_number FROM feedback_items
     WHERE status='resolved' AND agent_resolved_notified_at IS NULL
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

async function tellReporters(
  db: SqlDatabase,
  repository: string,
  number: number,
  version: string,
): Promise<number> {
  const items = (
    await db.query<ShippedItem>(
      `SELECT id,source_kind,created_at,reporter_identity_id,room_id,occurrences FROM feedback_items
       WHERE status='resolved' AND agent_resolved_notified_at IS NULL
         AND issue_number=$2 AND lower(issue_repository)=lower($1)
       ORDER BY created_at,id FOR UPDATE`,
      [repository, number],
    )
  ).rows;
  if (!items.length) return 0;
  const reporters = new Map<string, { roomId: string | null; time: number }>();
  const addReporter = (agentId: string, roomId: string | null, time: number) => {
    if (!reporters.has(agentId) || time > reporters.get(agentId)!.time)
      reporters.set(agentId, { roomId, time });
  };
  for (const item of items) {
    if (item.source_kind === 'agent')
      addReporter(item.reporter_identity_id, item.room_id, new Date(item.created_at).getTime());
    for (const occurrence of Array.isArray(item.occurrences) ? item.occurrences : []) {
      const { agentId, roomId, createdAt } = (occurrence ?? {}) as {
        agentId?: unknown; roomId?: unknown; createdAt?: unknown;
      };
      if (typeof agentId === 'string' && typeof createdAt === 'string')
        addReporter(agentId, typeof roomId === 'string' ? roomId : null, Date.parse(createdAt));
    }
  }
  const live = await db.query<{ id: string }>(
    `SELECT identity.id FROM identities identity WHERE identity.id=ANY($1::text[]) AND identity.kind='agent'`,
    [[...reporters.keys()]],
  );
  const rooms = new Set(
    (
      await db.query<{ id: string }>(`SELECT id FROM rooms WHERE id::text=ANY($1::text[])`, [
        [...new Set([...reporters.values()].map(({ roomId }) => roomId).filter((id): id is string => Boolean(id)))],
      ])
    ).rows.map((row) => row.id),
  );
  const url = systemMessage('feedback.https-github-com-pull', repository, number);
  let notified = 0;
  if (live.rowCount) await ensureSystemIdentity(db);
  for (const { id: agentId } of live.rows) {
    const roomId = reporters.get(agentId)?.roomId;
    if (!roomId || !rooms.has(roomId)) continue;
    const line = await systemLine(db, {
      id: createHash('sha256')
        .update(`beeline-feedback-shipped:v1:${url.toLowerCase()}:${agentId}`)
        .digest('hex'),
      roomId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'system', name: '' },
      verb: systemMessage('feedback.shipped', version, url),
      // Passive and unrouted: it informs the agent and wakes nobody.
      cardType: 'feedback-shipped',
      routeCommands: false,
    });
    if (line.inserted) notified++;
  }
  await db.query(`UPDATE feedback_items SET agent_resolved_notified_at=now(),
    resolved_notified_at=CASE WHEN source_kind='agent' THEN now() ELSE resolved_notified_at END WHERE id=ANY($1::text[])`, [
    items.map((item) => item.id),
  ]);
  return notified;
}

export async function reconcileFeedbackShipped(database: SqlDatabase, feedback: FeedbackLoop): Promise<void> {
  const release = (await database.query<ShippedRelease>(
    'SELECT version,sha FROM helper_release_notifications WHERE singleton=true',
  )).rows[0];
  if (release) await notifyFeedbackShipped(database, feedback, release);
}
