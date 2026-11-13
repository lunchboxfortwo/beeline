import { readLiveCornerChecks } from './corner-live-checks.js';
import { CornerLifecycleView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash,randomBytes } from 'node:crypto';
import { createAgentCommand,currentCornerCommandTargetSql,hasPendingCornerReview,type CommandRow } from './agent-command.js';
import { reportAgentAttention } from './commander.js';
import { releaseArchivedCornerHolds } from './corner-holds.js';
import { cornerIdleSql,type CornerIdleRow } from './corner-idle.js';
import { loadCorner,type CornerRow } from './corner-lifecycle-read-state.js';
import { cornerMergeGate,independentReviewerConfigured,loadCornerReviewState,lockCornerArchivalAuthority,lockCornerLifecycle,noteReviewDispatchFailure,reachableReviewer } from './corner-lifecycle-review-state.js';
import { OK,reviewChecksSql,type Applied,type CornerAdvance,type CornerEvent,type RevisionWake } from './corner-lifecycle-values.js';
import { transitionCorner,type CornerMachineFacts } from './corner-machine.js';
import { loadCornerWaiting } from './corner-waiting.js';
import { deleteCornerWakeSources } from './corner-wake-cleanup.js';
import type { SqlDatabase } from './database.js';
import { GITHUB_SUBJECT,ensureSystemIdentity,systemLine } from './system-line.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';



export const CORNER_GITHUB_CACHE_MIRROR_SQL = `
INSERT INTO corner_github_cache(corner_id,lifecycle)
  SELECT corner_id,lifecycle FROM corner_facts ON CONFLICT(corner_id) DO NOTHING;
CREATE OR REPLACE FUNCTION corner_facts_lifecycle_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  INSERT INTO corner_github_cache(corner_id,lifecycle) VALUES(NEW.corner_id,NEW.lifecycle)
  ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle
    WHERE corner_github_cache.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_facts_lifecycle_mirror ON corner_facts;
CREATE TRIGGER corner_facts_lifecycle_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_facts
  FOR EACH ROW EXECUTE FUNCTION corner_facts_lifecycle_mirror();
CREATE OR REPLACE FUNCTION corner_github_cache_mirror() RETURNS trigger LANGUAGE plpgsql AS $mirror$
BEGIN
  UPDATE corner_facts SET lifecycle=NEW.lifecycle
    WHERE corner_id=NEW.corner_id AND lifecycle IS DISTINCT FROM NEW.lifecycle;
  RETURN NULL;
END $mirror$;
DROP TRIGGER IF EXISTS corner_github_cache_mirror ON corner_github_cache;
CREATE TRIGGER corner_github_cache_mirror AFTER INSERT OR UPDATE OF lifecycle ON corner_github_cache
  FOR EACH ROW EXECUTE FUNCTION corner_github_cache_mirror();
`;


/**
 * The corner's own row: created once with the corner, then changed only by
 * this module (its lock and its reviewer). Its GitHub display cache row starts
 * with it and is then written only from GitHub (`corner_github_cache`).
 */
export async function createCornerFacts(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle)
     VALUES($1,'{"lifecycle":"working","checks":"unknown"}') ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
  await db.query(
    `INSERT INTO corner_github_cache(corner_id) VALUES($1) ON CONFLICT(corner_id) DO NOTHING`,
    [cornerId],
  );
}


/** A person's lock: merges then keep the corner open (`corner lock`). */
export async function setCornerLockedFact(
  db: SqlDatabase,
  cornerId: string,
  locked: boolean,
): Promise<void> {
  await db.query(`UPDATE corner_facts SET locked=$2 WHERE corner_id=$1`, [cornerId, locked]);
}


/** Account deletion: corners whose own reviewer was a deleted agent fall back to their Room's. */
export async function clearCornerReviewers(db: SqlDatabase, agentIds: string[]): Promise<void> {
  await db.query(`UPDATE corner_facts SET reviewer_agent_id=NULL WHERE reviewer_agent_id=ANY($1)`, [
    agentIds,
  ]);
}


/** Internal relation of room_id/identity_id pairs whose reviewer assignment ends. */
export function clearCornerReviewersForMembershipsSql(members: string): string {
  return `UPDATE corner_facts fact SET reviewer_agent_id=NULL
    FROM rooms corner,${members} member
    WHERE corner.id=fact.corner_id AND corner.parent_id=member.room_id
      AND fact.reviewer_agent_id=member.identity_id`;
}


/** The corner's own reviewer; returns whether it changed. Callers check authority first. */
export async function setCornerReviewerFact(
  db: SqlDatabase,
  cornerId: string,
  reviewerId: string,
): Promise<boolean> {
  return (
    ((
      await db.query(
        `UPDATE corner_facts SET reviewer_agent_id=$2
     WHERE corner_id=$1 AND reviewer_agent_id IS DISTINCT FROM $2 RETURNING corner_id`,
        [cornerId, reviewerId],
      )
    ).rowCount ?? 0) > 0
  );
}


/**
 * Cancels every pending item for a corner, and any
 * turn still marked `working`, so a corner that just landed never leaves a
 * stale assignment behind. Shared by every path that archives a corner:
 * `closeCornerState` and the GitHub merge webhook.
 * Take command locks before the room's archival UPDATE/FOR UPDATE lock:
 * command output already holds its command when dispatch locks rooms FOR SHARE.
 */
export async function cancelCornerAgentCommands(database: SqlDatabase, cornerId: string): Promise<void> {
  await lockCornerArchivalAuthority(database);
  // Cancelling is the stop: a helper running one of these items sees it
  // leave its queue and cancels that session's turn.
  await database.query(
    `SELECT (terminal.ended).* FROM (SELECT beeline_finish_agent_command(agent_commands.id,'cancelled','corner_close',NULL) ended FROM agent_commands WHERE room_id=$1 AND state='pending' ORDER BY created_at DESC,id DESC) terminal`,
    [cornerId],
  );
  await database.query(`DELETE FROM agent_pending_attachments WHERE room_id=$1`, [cornerId]);
}



/** Startup/data migration admission uses committed facts only, never GitHub. */
export async function backfillCornerLifecycleRuns(db: SqlDatabase): Promise<number> {
  const rows = (
    await db.query<{ corner_id: string }>(
      'SELECT corner_id FROM corner_facts WHERE machine IS NULL',
    )
  ).rows;
  for (const row of rows) await advanceCorner(db, row.corner_id, { kind: 'reconcile' });
  return rows.length;
}


/** A confirmed merge is an event; callers never write archive state themselves. */
export async function archiveCornerState(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return (await advanceCorner(database, cornerId, { kind: 'merged', contents: {} })).archived === true;
}


export async function archiveCorner(database: SqlDatabase, cornerId: string): Promise<boolean> {
  return database.transaction(async database => {
    await lockCornerLifecycle(database, cornerId);
    await lockCornerArchivalAuthority(database);
    if (!(await database.query(`SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL FOR KEY SHARE`, [cornerId])).rowCount)
      throw new Error('corner not found');
    await cancelCornerAgentCommands(database, cornerId);
    // Match command output: command locks precede the Room archival write lock.
    const changed = await database.query(
      `UPDATE rooms SET archived_at=now(),updated_at=now() WHERE id=$1 AND archived_at IS NULL`, [cornerId]);
    await abandonCornerWorkflowRuns(database, cornerId);
    await deleteCornerWakeSources(database, [cornerId]);
    await releaseArchivedCornerHolds(database, [cornerId]);
    return Boolean(changed.rowCount);
  });
}


/** A caller's fact write (head, checks, approval, merge) runs under the corner
 * row lock, after the unlocked read. `project` is what that write will make
 * visible. `write` rechecks the head or authority and commits the fact.
 * False skips the machine write. A returned event replaces the projected one. */
export type CornerAdvanceCommit = {
  project(corner: CornerRow): {
    corner: CornerRow;
    facts?: Partial<CornerMachineFacts>;
    /** Null commits the fact and does not run the machine. */
    event?: CornerEvent | null;
  } | undefined;
  write(db: SqlDatabase): Promise<boolean | CornerEvent>;
};


export async function advanceCorner(
  database: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
  commit?: CornerAdvanceCommit,
): Promise<CornerAdvance> {
  // The corner row lock covers only the compare-and-write below. Every fact is
  // read first without it, so events on one busy corner never queue behind
  // another event's slow reads. A commit to the row in between changes its
  // version; the write then reads the newer facts and compares again.
  if (commit) return advanceCornerCommitted(database, cornerId, event, commit);
  // Events can release an owed review long after its green webhook. Refresh
  // before planning the wake; provider-backed commits already carry their read.
  if (event.kind === 'reconcile' || event.kind === 'checks' || event.kind === 'approval' || event.kind === 'brief-revised') {
    const cached = await loadCorner(database, cornerId, false);
    if (!cached?.archived && cached?.lifecycle.pr && cached.lifecycle.checks === 'passing')
      await readLiveCornerChecks(database, cornerId);
  }
  for (;;) {
    const read = await readCornerAdvance(database, cornerId, event);
    if (!read) return { accepted: false, state: undefined };
    const written = await database.transaction(async db => {
      const locked = await loadCorner(db, cornerId, event.kind === 'reconcile' ? 'skip-locked' : true);
      if (!locked) return { accepted: false, state: undefined };
      if (JSON.stringify(locked) !== JSON.stringify(read.corner)) return undefined;
      return writeCornerAdvance(db, cornerId, event, read);
    });
    if (written) return written;
  }
}


async function advanceCornerCommitted(
  database: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
  commit: CornerAdvanceCommit,
): Promise<CornerAdvance> {
  for (;;) {
    const corner = await loadCorner(database, cornerId, false);
    if (!corner) return { accepted: false, state: undefined };
    const projected = commit.project(corner);
    if (!projected) return { accepted: false, state: corner.machine?.state };
    const chosen = projected.event === undefined ? event : projected.event;
    if (chosen === null) {
      const wrote = await database.transaction(async db => {
        const locked = await loadCorner(db, cornerId, true);
        if (!locked) return { accepted: false, state: undefined };
        if (JSON.stringify(locked) !== JSON.stringify(corner)) return undefined;
        await commit.write(db);
        return { accepted: false, state: locked.machine?.state };
      });
      if (wrote) return wrote;
      continue;
    }
    const read = await readCornerAdvance(database, cornerId, chosen, {
      corner: projected.corner, facts: projected.facts, before: corner.lifecycle,
    });
    if (!read) return { accepted: false, state: undefined };
    const written = await database.transaction(async db => {
      // The caller's fact write has to land. A reconcile event still waits:
      // the lock now covers only this compare-and-write, so a skip would drop
      // the check or head update while another event holds the row.
      const locked = await loadCorner(db, cornerId, true);
      if (!locked) return { accepted: false, state: undefined };
      if (JSON.stringify(locked) !== JSON.stringify(corner)) return undefined;
      const result = await commit.write(db);
      if (result === false) return { accepted: false, state: locked.machine?.state };
      return writeCornerAdvance(db, cornerId, result === true ? chosen : result, read);
    });
    if (written) return written;
  }
}


type CornerAdvanceRead = {
  corner: CornerRow;
  head: string | undefined;
  row: CornerIdleRow | undefined;
  checkSource: { id: string } | undefined;
  facts: CornerMachineFacts;
};


/** Every fact for one event, read without the corner row lock. */
async function readCornerAdvance(
  db: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
  projected?: { corner: CornerRow; facts?: Partial<CornerMachineFacts>; before?: CornerLifecycleView },
): Promise<CornerAdvanceRead | undefined> {
    // The row is read first: a later commit to it makes the version differ at the write.
    const corner = projected?.corner ?? await loadCorner(db, cornerId, false);
    if (!corner) return undefined;
    const head = corner.lifecycle.pr?.headSha ?? (event.kind === 'push' ? event.headSha : undefined);
    await ensureSystemIdentity(db);
    const row = (await db.query<CornerIdleRow>(cornerIdleSql('$1', true), [cornerId])).rows[0];
    const sourceHead =
      event.kind === 'checks'
        ? (
            await db.query<{ head: string | null }>(
              `SELECT system_event->'object'->>'headSha' head FROM messages WHERE id=$1 AND room_id=$2`,
              [event.sourceMessageId, cornerId],
            )
          ).rows[0]?.head
        : undefined;
    const checkSource = (
      await db.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1
      AND system_event->>'kind'=$2 AND (system_event->'object'->>'headSha' IS NULL OR system_event->'object'->>'headSha'=$3)
      ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          cornerId,
          corner.lifecycle.checks === 'failing' ? 'check-failed' : 'check-passed',
          head ?? null,
        ],
      )
    ).rows[0];
    const review = await loadCornerReviewState(db,cornerId,head);
    // Completed commands still prove delivery; only missing IDs invalidate their receipts.
    const receipts = (corner.machine?.effects ?? []).filter(key => key.startsWith('command:red:')).map(marker => ({
      marker, key: marker.slice('command:'.length, marker.lastIndexOf(':')), id: marker.slice(marker.lastIndexOf(':') + 1),
    }));
    const active = (
      await db.query<{ worker: boolean; conflict: boolean; retained: string[] | null }>(
        `SELECT
      EXISTS(SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
        AND state='pending' AND action='input' AND reason<>'report' AND ${currentCornerCommandTargetSql('agent_commands')}) worker,
      EXISTS(SELECT 1 FROM agent_commands delivered JOIN messages source ON source.id=delivered.source_message_id
        WHERE delivered.room_id=$1 AND delivered.reason='corner_merge_conflict'
          AND source.system_event->'object'->>'headSha'=$3) conflict,
      (SELECT array_agg(id) FROM agent_commands WHERE id=ANY($4::text[])) retained`,
        [
          cornerId,
          corner.worker_agent_id,
          head ?? null,
          receipts.map(receipt => receipt.id),
        ],
      )
    ).rows[0];
    const waiting = await loadCornerWaiting(db,cornerId);
    const gate =
      head && corner.lifecycle.pr?.number
        ? await cornerMergeGate(db, cornerId, { number: corner.lifecycle.pr.number, headSha: head })
        : undefined;
    const facts: CornerMachineFacts = {
      archived: corner.archived,
      locked: corner.locked,
      lifecycle: corner.lifecycle,
      headSha: head,
      turnRunning: row?.worker_active === true || active?.worker === true,
      implementerActive: active?.worker === true,
      reviewerActive: row?.reviewer_active === true || review.pending,
      // Activity owns the displayed state. Only a request sent with passing
      // checks suppresses the first green-head review dispatch.
      reviewRequestActive: review.pending,
      reviewRequests: review.requests,
      approved: gate?.approved,
      mergeHeld: gate?.held,
      mergeConflictDelivered: active?.conflict,
      lostEffects: receipts.filter(receipt => !active?.retained?.includes(receipt.id)).flatMap(receipt => [receipt.key, receipt.marker]),
      draftReadyFailure: (corner.lifecycle as CornerLifecycleView & { draftReadyFailure?: { headSha?: string } }).draftReadyFailure?.headSha === head && Boolean(head),
      reviewerConfigured: independentReviewerConfigured(corner),
      ...(waiting ? {waitReason:waiting.wait_reason} : {}),
      ...(review.ended ? {reviewEnded:review.ended} : {}),
      ...(waiting ? {blocker:{reason:waiting.reason,itemId:waiting.item_id,
        ...(waiting.kind ? {blocker:{kind:waiting.kind}} : {})}}
        : row?.waiting_kind==='merge-hold' ? {blocker:{reason:row.waiting_reason!,itemId:row.waiting_item_id!,blocker:{kind:'merge-hold' as const}}} : {}),
      checkSourceId:
        sourceHead && sourceHead !== head
          ? 'stale'
          : event.kind === 'checks'
            ? event.sourceMessageId
            : checkSource?.id ?? (corner.lifecycle.checks === 'failing' && head && (!corner.lifecycle.checksSummary || (corner.lifecycle.checksSummary as {reportedFailing?:string[]}).reportedFailing?.length)
              ? `cache:${head}` : undefined),
      idleSince: row?.idle_since,
      idleEligible: row
        ? !row.suppressed && !row.worker_active && !row.reviewer_active && !row.blocking
        : false,
    };
    if (projected?.before) alignProjectedIdle(row, facts, corner.lifecycle, projected.before);
    if (projected?.facts) Object.assign(facts, projected.facts);
    return { corner, head, row, checkSource, facts };
}


/** The idle snapshot still sees the committed lifecycle. A projected check or
 * head change suppresses idle the same way the snapshot would after the write. */
function alignProjectedIdle(
  row: CornerIdleRow | undefined,
  facts: CornerMachineFacts,
  projected: CornerLifecycleView,
  before: CornerLifecycleView,
): void {
  const suppresses = (lifecycle: CornerLifecycleView) => {
    const summary = lifecycle.checksSummary as { status?: string; fetchStartedAt?: number } | undefined;
    return lifecycle.checks === 'pending' || Boolean(
      lifecycle.pr && summary?.status === 'unknown' && summary.fetchStartedAt === undefined,
    );
  };
  if (suppresses(projected) && !suppresses(before)) {
    facts.idleEligible = false;
    if (row) row.suppressed = true;
  }
  const summary = projected.checksSummary as { statusChangedAt?: number; updatedAt?: number } | undefined;
  const stamp = summary?.statusChangedAt ?? summary?.updatedAt;
  if (row && typeof stamp === 'number' && Number(row.idle_since) < stamp) {
    row.idle_since = String(stamp);
    facts.idleSince = row.idle_since;
  }
}


/** Holds the corner row lock: the machine transition and its effects only. */
async function writeCornerAdvance(
  db: SqlDatabase,
  cornerId: string,
  event: CornerEvent,
  { corner, head, row, checkSource, facts }: CornerAdvanceRead,
): Promise<CornerAdvance> {
    const prior = corner.machine ?? { state: 'idle' };
    const plan = transitionCorner(prior, { facts, event });
    if (plan.suppression) return { state: prior.state, accepted: false };
    const archived = plan.state.state === 'archived' && !corner.archived &&
      (event.kind === 'closed' || event.kind === 'merged' || corner.lifecycle.outcome === 'landed' || corner.lifecycle.pr?.mergedAt)
      ? await archiveCorner(db, cornerId) : false;
    if (event.kind === 'closed') await db.query(
      `UPDATE corner_github_cache SET lifecycle=lifecycle||'{"lifecycle":"done","checks":"unknown"}'::jsonb WHERE corner_id=$1`, [cornerId]);
    let wakeResult: RevisionWake | undefined;
    const effects = [...(plan.state.effects ?? [])];
    for (const effect of plan.wakes) {
      let result: Applied = OK;
      const sourceId = event.kind === 'checks' ? event.sourceMessageId : checkSource?.id;
      switch (effect.kind) {
        case 'merge-conflict': {
          // The machine wakes this effect only for a live-read conflict event.
          if (event.kind !== 'merge-conflict') break;
          const source = event.sourceMessageId;
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: source,
                reason: 'corner_merge_conflict',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'open': {
          const command =
            event.kind === 'open' && event.command
              ? await createAgentCommand(db, event.command)
              : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
        case 'revision': {
          if (event.kind !== 'brief-revised') break;
          const agentId = corner.worker_agent_id !== event.command.agent_id ? corner.worker_agent_id : null;
          const command = agentId
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId,
                sourceMessageId: event.sourceMessageId,
                reason: 'corner_brief_revision',
                parent: event.command,
                retainDepth: true,
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : { reason: 'No reachable implementer for the revision' }) },
          };
          break;
        }
        case 'checks-failed':
          if (!corner.worker_agent_id) {
            await noteReviewDispatchFailure(db, cornerId, head ?? 'checks', 'the corner has no implementer');
            result = { ok: true, wake: { queued: false, reason: 'the corner has no implementer' } };
          } else if (facts.checkSourceId && corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: sourceId ?? null,
              ...(!sourceId ? { id: createHash('sha256').update(`cached-checks:${cornerId}:${corner.lifecycle.pr?.number}:${head}`).digest('hex'),
                privatePayload: { kind: 'lifecycle' as const, authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId,
                  text: `Failing checks on head ${head}: ${corner.lifecycle.checksSummary?.failing.length ? corner.lifecycle.checksSummary.failing.join(', ') : 'the recorded checks failed; read the current checks for details'}. Fix these recorded failures.` } } : {}),
              reason: 'corner_check',
            });
            if (command) effects.push(`command:${effect.key}:${command.id}`);
            if (command && !sourceId) await db.query(`UPDATE agent_commands SET review_context=jsonb_build_object(
              'cornerId',$2::text,'headSha',$3::text,'pullRequest',$4::int,'briefRevision',
              COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$2::uuid),0),'purpose','repair') WHERE id=$1`,
              [command.id,cornerId,head,corner.lifecycle.pr?.number]);
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'review': {
          const reviewer = reachableReviewer(corner);
          if (!reviewer) {
            result = await noteReviewBlocked(
              db,
              cornerId,
              corner,
              head!,
              'the configured reviewer is unreachable',
              false,
            );
            break;
          }
          const source =
            event.kind === 'checks' && sourceId ? sourceId :
            (
              await systemLine(db, {
                roomId: cornerId,
                authorId: corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
                subject: GITHUB_SUBJECT,
                verb: systemMessage('corner-lifecycle.requested-review-of'),
                object: { text: corner.lifecycle.pr?.title ?? 'Pull request', headSha: head },
              })
            ).id;
          const queued = await queueReviewerCommand(db, {
            roomId: cornerId,
            agentId: reviewer,
            sourceMessageId: source,
            reason: 'corner_review_dispatch',
          });
          if (queued.blocked || queued.command?.state === 'pending')
            delete plan.state.reviewDue;
          result = queued.command
            ? { ok: true, wake: { queued: true, agentId: reviewer } }
            : queued.blocked
              ? OK
              : await noteReviewBlocked(
                  db,
                  cornerId,
                  corner,
                  head!,
                  `the reviewer command could not be queued${queued.error ? `: ${queued.error}` : ''}`,
                );
          // Lost/cancelled unclaimed review commands are recoverable. Durable
          // command facts, rather than an effect receipt, suppress live reviews.
          break;
        }
        case 'review-gap':
          result = await noteMissingReviewer(
            db,
            cornerId,
            corner,
            `${corner.lifecycle.pr?.number}:${head}`,
          );
          break;
        case 'review-findings': {
          if (facts.reviewEnded?.emptyCount) break;
          const reason = facts.reviewEnded?.findings ?? 'Review failed';
          const command = corner.worker_agent_id ? await createAgentCommand(db,{
            id:createHash('sha256').update(`review-failed:${cornerId}:${head}:${facts.reviewEnded!.id}`).digest('hex'),
            roomId:cornerId,agentId:corner.worker_agent_id,sourceMessageId:null,reason:'corner_review_needed',
            privatePayload:{kind:'lifecycle',authorId:SYSTEM_IDENTITY_ID,fromRoomId:cornerId,text:`FAIL: ${reason}`},
          }) : undefined;
          result={ok:true,wake:{queued:Boolean(command),...(command?{agentId:command.agent_id}:{})}};
          break;
        }
        case 'land':
          if (corner.worker_agent_id) {
            const command = await createAgentCommand(db, {
              id: createHash('sha256')
                .update(`corner-land:${cornerId}:${corner.lifecycle.pr?.number}:${head}`)
                .digest('hex'),
              roomId: cornerId,
              agentId: corner.worker_agent_id,
              sourceMessageId: null,
              reason: 'corner_land',
              privatePayload: {
                kind: 'lifecycle',
                authorId: SYSTEM_IDENTITY_ID,
                fromRoomId: cornerId,
                text: `A yes is recorded on ${head} and checks passed. Call merge_corner through the normal merge gate.`,
              },
            });
            result = {
              ok: true,
              wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
            };
          }
          break;
        case 'merge-refused': {
          if (event.kind !== 'merge-refused') break;
          const command = corner.worker_agent_id
            ? await createAgentCommand(db, {
                roomId: cornerId,
                agentId: corner.worker_agent_id,
                sourceMessageId: null,
                privatePayload: { kind: 'lifecycle', authorId: SYSTEM_IDENTITY_ID, fromRoomId: cornerId, text: event.reason },
                reason: 'corner_merge_refused',
              })
            : undefined;
          result = {
            ok: true,
            wake: { queued: Boolean(command), ...(command ? { agentId: command.agent_id } : {}) },
          };
          break;
        }
      }
      if (result.wake) wakeResult = result.wake;
      if (!['review', 'command'].includes(effect.kind) && (result.wake?.queued || !result.wake))
        effects.push(effect.key);
    }
    for (const notice of plan.notifications) {
      if (notice.kind === 'draft') await reportAgentAttention(db, cornerId, corner.worker_agent_id ?? SYSTEM_IDENTITY_ID,
        systemMessage('agent-command.blocked-pr-is-a-draft-marking-it-ready-for-review-failed'), undefined,
        createHash('sha256').update(`draft-blocked:${cornerId}:${head}`).digest('hex'),
        {});
      if (notice.kind === 'idle' && row) {
        await reportAgentAttention(
          db,
          cornerId,
          SYSTEM_IDENTITY_ID,
          `blocked: Corner ${row.name} is idle. Resume it, set a hold, or close it.`,
          undefined,
          createHash('sha256').update(`idle:${cornerId}:${row.idle_since}`).digest('hex'),
          { automatic: true, idleSince: row.idle_since },
        );
      }
      // Explicit reports, owed asks and action cards already deliver to their
      // commander. The machine records the wait; it never broadcasts to Room people.
      effects.push(notice.key);
    }
    const state = { ...plan.state, effects };
    // Any write here changes the row version, so an event that read before this
    // commit reads again. Only a write-free event leaves the version alone.
    const wrote = archived || event.kind === 'closed' || plan.wakes.length > 0 ||
      plan.notifications.length > 0;
    await db.query(
      `UPDATE corner_facts SET machine=$2::jsonb WHERE corner_id=$1 AND ($3 OR machine IS DISTINCT FROM $2::jsonb)`,
      [cornerId, JSON.stringify(state), wrote],
    );
    return {
      state: state.state,
      accepted: true,
      ...(archived ? { archived: true } : {}),
      ...(wakeResult ? { wake: wakeResult } : {}),
    };
}


/** Zero checks need the commander's yes; other review gaps retain their handback. */
export async function noteMissingReviewer(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
): Promise<Applied> {
  if (corner.lifecycle.checksSummary?.total === 0) {
    const command = corner.worker_agent_id
      ? await createAgentCommand(db, {
          id: createHash('sha256').update(`zero-check-ready:${cornerId}:${headKey}`).digest('hex'),
          roomId: cornerId,
          agentId: corner.worker_agent_id,
          sourceMessageId: null,
          privatePayload: {
            text: "This pull request has no checks and no reviewer. Landing needs your commander's yes. Ask your commander using your normal report tool.",
            authorId: SYSTEM_IDENTITY_ID,
            fromRoomId: cornerId,
            kind: 'lifecycle',
          },
          reason: 'corner_review_needed',
        })
      : undefined;
    return {
      ok: true,
      wake: command
        ? { queued: true, agentId: corner.worker_agent_id! }
        : {
            queued: false,
            reason: 'The implementer cannot be woken to ask its commander for a merge decision',
          },
    };
  }
  return noteReviewBlocked(
    db,
    cornerId,
    corner,
    headKey,
    systemMessage('corner-lifecycle.no-reviewer-is-configured'),
  );
}


/**
 * One handback for every review gap. The implementer owns arranging another
 * review or reporting the blocker up the chain; a passive transcript note
 * alone cannot make that happen. A stable episode key dedupes fact replays.
 */
export async function noteReviewBlocked(
  db: SqlDatabase,
  cornerId: string,
  corner: CornerRow,
  headKey: string,
  reason: string,
  reportCommander = true,
): Promise<Applied> {
  const episode = `${cornerId}:${headKey}:${reason}`;
  if (reportCommander)
    await reportAgentAttention(
      db,
      cornerId,
      SYSTEM_IDENTITY_ID,
      systemMessage('corner-lifecycle.blocked', reason),
      undefined,
      createHash('sha256').update(`review-gap:${episode}`).digest('hex'),
      // The review gate is corner work: wake the implementer where its PR lives.
      { wakeInCorner: true },
    );
  const command = corner.worker_agent_id
    ? await createAgentCommand(db, {
        id: createHash('sha256').update(`review-needed:${episode}`).digest('hex'),
        roomId: cornerId,
        agentId: corner.worker_agent_id,
        sourceMessageId: null,
        privatePayload: {
          text: `${corner.lifecycle.checks === 'passing' ? 'Checks passed; ' : ''}${reason}; arrange review or report the blocker to its commander`,
          authorId: SYSTEM_IDENTITY_ID,
          fromRoomId: cornerId,
          kind: 'lifecycle',
        },
        reason: 'corner_review_needed',
      })
    : undefined;
  const wakeResult = command
    ? { queued: true, agentId: corner.worker_agent_id! }
    : {
        queued: false,
        reason: systemMessage('corner-lifecycle.the-implementer-cannot-be-woken-to-arrange-review'),
      };
  if (!command) await noteReviewDispatchFailure(db, cornerId, headKey, wakeResult.reason!);
  return { ok: true, wake: wakeResult };
}


export async function queueReviewerCommand(
  db: SqlDatabase,
  input: Parameters<typeof createAgentCommand>[1],
): Promise<{ command?: CommandRow; error?: string; blocked?: boolean }> {
  const brief = (
    await db.query<{ revision: number }>(
      `SELECT revision FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
      [input.roomId],
    )
  ).rows[0];
  const context = (
    await db.query<{ context: Record<string, unknown> | null }>(
      `SELECT CASE WHEN lifecycle->'pr'->>'headSha' IS NOT NULL AND lifecycle->'pr'->>'number' IS NOT NULL
       THEN jsonb_build_object('cornerId',corner_id,'headSha',lifecycle->'pr'->>'headSha',
       'pullRequest',lifecycle->'pr'->'number','briefRevision',$2::int,
       'checks',${reviewChecksSql}) ELSE NULL END context
     FROM corner_github_cache WHERE corner_id=$1`,
      [input.roomId, brief?.revision ?? 0],
    )
  ).rows[0]?.context;
  const headSha = typeof context?.headSha === 'string' ? context.headSha : undefined;
  const rawPull = context?.pullRequest;
  const pullRequest =
    typeof rawPull === 'number'
      ? rawPull
      : typeof rawPull === 'string' && /^\d+$/.test(rawPull)
        ? Number(rawPull)
        : null;
  if (
    headSha !== undefined &&
    (await hasPendingCornerReview(db, input.roomId, input.agentId, headSha, pullRequest))
  )
    return { blocked: true };
  const prior = (
    await db.query<{ text: string }>(
      `SELECT evidence.text FROM agent_commands command
       CROSS JOIN LATERAL (
         SELECT message.text,message.created_at FROM messages message
         WHERE message.author_id=command.agent_id AND message.deleted_at IS NULL
           AND (message.id=command.result_message_id OR message.id IN (
             SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb))))
         UNION ALL
         SELECT report.private_payload->>'text',report.created_at FROM agent_commands report
         WHERE (report.id=command.result_message_id OR report.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb))))
           AND report.private_payload->>'authorId'=command.agent_id
       ) evidence
       WHERE command.room_id=$1 AND command.agent_id=$2 AND command.review_context IS NOT NULL
         AND command.state='complete'
       ORDER BY command.inbox_sequence DESC,evidence.created_at DESC LIMIT 1`,
      [input.roomId, input.agentId],
    )
  ).rows[0]?.text;
  // A rejected insert must leave this transaction usable so the failure line
  // can commit. A broken connection still propagates rather than pretending
  // the reviewer was woken.
  await db.query('SAVEPOINT corner_reviewer_dispatch');
  try {
    const command = await createAgentCommand(db, {
      ...input,id:input.id ?? randomBytes(32).toString('hex'),
      // The helper builds the head and newest brief revision at delivery.
      ...(prior ? { wakeNote: `Prior reviewer verdict and evidence (historical context):\n${prior}` } : {}),
    });
    if (command)
      await db.query('UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1', [
        command.id,
        context ? JSON.stringify(context) : null,
      ]);
    if (command) command.review_context = context as Record<string, unknown> | null;
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return { command };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT corner_reviewer_dispatch');
    await db.query('RELEASE SAVEPOINT corner_reviewer_dispatch');
    return {
      error:
        error instanceof Error
          ? error.message.slice(0, 160)
          : systemMessage('corner-lifecycle.unknown-dispatch-error'),
    };
  }
}
export { CORNER_LIFECYCLE_SLUG } from './corner-lifecycle-values.js';

export { lockCornerLifecycle } from './corner-lifecycle-review-state.js';

export type { CornerMachine } from './corner-machine.js';

export type { CornerMachineFacts } from './corner-machine.js';

export type { CornerMachineEvent } from './corner-machine.js';

export { transitionCorner } from './corner-machine.js';

export { deriveCornerState } from './corner-machine.js';

export { planCornerCheckObservation } from './corner-machine.js';

export { checksSettled } from './corner-machine.js';

export { checksRestarted } from './corner-machine.js';

export { actionsJobId } from './corner-machine.js';

export type { CornerAdvance,CornerEvent } from './corner-lifecycle-values.js';

export { CORNER_MACHINE_SCHEMA } from './corner-lifecycle-values.js';



export { lockCornerArchivalAuthority } from './corner-lifecycle-review-state.js';



export { cornerReviewWokenSql } from './corner-lifecycle-review-state.js';

export { loadCornerReviewState } from './corner-lifecycle-review-state.js';

export type { CornerMergeGate } from './corner-lifecycle-review-state.js';

export type { CornerMergeabilityInput } from './corner-lifecycle-review-state.js';

export { cornerMergeability } from './corner-lifecycle-review-state.js';

export { cornerMergeGate } from './corner-lifecycle-review-state.js';

export { confirmCornerMergeAuthority } from './corner-lifecycle-review-state.js';

export { deleteStoredCornerWorkflows } from './corner-lifecycle-review-state.js';
