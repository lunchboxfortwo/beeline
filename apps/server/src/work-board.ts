import type { OpenBacklogTask } from '@beeline/api-contract/daemon';
import { cornerBlockerSql } from './chat-corner-counts.js';
import {
  cornerShortTitle,
  WORK_STATES,
  threadWorkState,
  type UpdateWorkItemInput,
  type WorkBoardView,
  type WorkItemView,
  type WorkState,
} from '@beeline/api-contract/phone';
import {
  addWorkNote,
  attachToWorkItem,
  workDetailColumnsSql,
  projectWorkDetail,
  type WorkDetailRow,
} from './work-item-detail.js';
import type { SqlDatabase } from './database.js';
import { phoneIdentity, type PhoneIdentityRow } from './phone-identity.js';
import { needsYouItems, needsYouRowText } from './needs-you.js';
import { cornerImplementerSql } from './corner-worker.js';
import { cornerObjectiveSql, writeCornerObjective } from './corner-objective.js';
import { CommandRefusalError } from './command-refusal.js';
import { advanceCorner, type CornerMachine } from './corner-lifecycle.js';
import {
  clearWorkAssignmentMarks,
  deterministicWorkItemUuid,
  extractBracketedWorkTitle,
  normalizeWorkObjective,
  normalizeWorkTitle,
  notifyWorkAssignment,
  parkThreadInBacklog,
  promoteBacklogTaskRow,
  promoteUnopenedTaskToThread,
  resolveWorkAssigneeId,
  resumeParkedThread,
  WORK_ITEM_UUID_RE,
  type UpdateWorkItemHooks,
} from './work-board-lifecycle.js';

export {
  clearWorkAssignmentMarks,
  deterministicWorkItemUuid,
  normalizeWorkTitle,
  type UpdateWorkItemHooks,
} from './work-board-lifecycle.js';

export async function promoteBacklogTaskInThread(
  db: SqlDatabase,
  input: {
    taskId: string;
    cornerId: string;
    effectiveName: string;
    objective: string;
    implementerAgentId: string;
    actorId: string;
  },
): Promise<void> {
  await promoteBacklogTaskRow(db, input, (tx, data, actorId) => updateWorkItem(tx, data, actorId));
}

type WorkRow = WorkDetailRow & {
  id: string;
  room_id: string;
  room_kind: 'direct' | 'room' | 'corner';
  chat_id: string;
  chat_name: string;
  name: string;
  thread_name: string;
  /** A task's stored state; null for a thread's own row, whose machine decides. */
  state: WorkState | null;
  thread: boolean;
  thread_machine: CornerMachine | null;
  thread_blocker_person: string | null;
  room_archived: boolean;
  objective: string;
  assignee: PhoneIdentityRow | null;
  opener: PhoneIdentityRow;
  created_at: Date;
  updated_at: Date;
};

/** Membership scopes access, never who may edit an accessible task. */
export async function workBoardScope(
  db: SqlDatabase,
  roomId: string,
  viewerId: string,
): Promise<string | null> {
  return (
    (
      await db.query<{ workspace_id: string }>(
        `SELECT r.workspace_id FROM rooms r
    JOIN room_access a ON a.room_id=r.id AND a.identity_id=$2 AND a.removed_at IS NULL
    JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL
      AND w.identity_id=$2 AND w.removed_at IS NULL WHERE r.id=$1`,
        [roomId, viewerId],
      )
    ).rows[0]?.workspace_id ?? null
  );
}

/**
 * One-time fold of the retired second thread state: a stored Backlog becomes an open
 * thread's machine Backlog input. Every thread row's stored state is then cleared.
 */
export async function foldThreadWorkStates(database: SqlDatabase): Promise<void> {
  const threadRows = `FROM rooms r WHERE r.id::text=w.id AND r.parent_id IS NOT NULL AND w.state IS NOT NULL`;
  const rows = (
    await database.query<{ id: string }>(
      `SELECT w.id FROM work_items w
     JOIN rooms r ON r.id::text=w.id AND r.parent_id IS NOT NULL
     WHERE w.state='backlog' AND r.archived_at IS NULL`,
    )
  ).rows;
  for (const row of rows) await advanceCorner(database, row.id, { kind: 'backlog', backlog: true });
  await database.query(`UPDATE work_items w SET state=NULL,completed_at=NULL ${threadRows}`);
}

/**
 * One-time idempotent migration:
 * 1. For `work_item_threads` rows:
 *    - When a linked thread is still open (`archived_at IS NULL`) or `landed = true`
 *      (or `w.state <> 'backlog'`), folds the task into `work_items(id = thread_id::text)`,
 *      re-pointing entries and non-self attachments, stripping synthetic `Thread: ...` web links,
 *      and preserving objective, assignee, and opener.
 *    - When `w.state = 'backlog'` and all linked threads already archived with `landed = false`,
 *      keeps `w` as an open standalone Backlog item (removing `work_item_threads` rows and
 *      synthetic `Thread: ...` web links) so unfinished backlog items stay visible to pick up.
 * 2. Normalizes remaining standalone `work_items` (`source_message_id IS NULL`): re-keys non-UUID
 *    IDs to deterministic RFC-4122 UUIDs, unwraps `[slug] ...` titles (moving trailing prose into
 *    empty objectives), and strips synthetic `Thread: ...` web links.
 */
export async function unifyWorkItemsAndThreads(database: SqlDatabase): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.query("SELECT set_config('beeline.work_migration','on',true)");

    const linked = (
      await tx.query<{
        work_item_id: string;
        thread_id: string;
        thread_name: string;
        thread_archived: boolean;
        landed: boolean;
        work_state: WorkState | null;
        title: string | null;
        objective: string | null;
        assignee_id: string | null;
        opened_by: string;
      }>(
        `SELECT DISTINCT ON (wit.work_item_id)
           wit.work_item_id,wit.thread_id::text thread_id,thread.name thread_name,
           (thread.archived_at IS NOT NULL) thread_archived,wit.landed,w.state work_state,
           w.title,w.objective,w.assignee_id,w.opened_by
         FROM work_item_threads wit
         JOIN work_items w ON w.id=wit.work_item_id
         JOIN rooms thread ON thread.id=wit.thread_id
         ORDER BY wit.work_item_id,wit.landed DESC,(thread.archived_at IS NULL) DESC,wit.created_at DESC,wit.thread_id DESC`,
      )
    ).rows;
    for (const row of linked) {
      await tx.query(
        `DELETE FROM work_item_attachments a
         WHERE a.work_item_id=$1 AND a.kind='link'
           AND EXISTS(
             SELECT 1 FROM work_item_threads wit
             JOIN rooms t ON t.id=wit.thread_id
             JOIN LATERAL (
               SELECT COALESCE(NULLIF(m.card->>'name',''),NULLIF(m.system_event->'object'->>'text','')) opening_name
               FROM messages m
               WHERE m.card_type='daemon-fact' AND m.deleted_at IS NULL AND m.card->>'cornerId'=t.id::text
                 AND (m.system_event->>'kind'='corner-opened' OR m.system_event->>'verb'='opened a corner')
                 AND COALESCE(NULLIF(m.card->>'name',''),NULLIF(m.system_event->'object'->>'text','')) IS NOT NULL
               ORDER BY m.created_at,m.id
               LIMIT 1
             ) opened ON true
             WHERE wit.work_item_id=$1
               AND a.url='https://web.usebeeline.app/beeline/chat/' || t.id::text || '?communityId=' || t.workspace_id::text
               AND a.name='Thread: ' || opened.opening_name
           )`,
        [row.work_item_id],
      );
      const keepOpenBacklog = row.work_state === 'backlog' && row.thread_archived && !row.landed;
      if (keepOpenBacklog) {
        await tx.query(`DELETE FROM work_item_threads WHERE work_item_id=$1`, [row.work_item_id]);
        continue;
      }
      const normalizedTitle = normalizeWorkTitle(row.title ?? row.thread_name) ?? row.thread_name;
      const trailingObjective = row.title ? extractBracketedWorkTitle(row.title).trailing : '';
      const normalizedObjective = row.objective?.trim()
        ? row.objective
        : trailingObjective
          ? (normalizeWorkObjective(trailingObjective) ?? row.objective)
          : row.objective;
      const existingThread = (
        await tx.query<{
          title: string | null;
          objective: string | null;
          assignee_id: string | null;
          opened_by: string;
        }>(`SELECT title,objective,assignee_id,opened_by FROM work_items WHERE id=$1`, [
          row.thread_id,
        ])
      ).rows[0];
      await updateWorkItem(
        tx,
        {
          roomId: row.thread_id,
          id: row.thread_id,
          title: existingThread?.title ?? normalizedTitle,
          objective: existingThread?.objective?.trim()
            ? existingThread.objective
            : (normalizedObjective ?? undefined),
          assigneeId: existingThread?.assignee_id ?? row.assignee_id,
        },
        existingThread?.opened_by ?? row.opened_by,
      );
      if (!existingThread) {
        await tx.query(`UPDATE work_items SET opened_by=$2,updated_at=now() WHERE id=$1`, [
          row.thread_id,
          row.opened_by,
        ]);
      }
      if (row.work_item_id !== row.thread_id) {
        await tx.query(
          `UPDATE work_item_entries SET work_item_id=$2 WHERE work_item_id=$1`,
          [row.work_item_id, row.thread_id],
        );
        await tx.query(
          `UPDATE work_item_attachments SET work_item_id=$2 WHERE work_item_id=$1`,
          [row.work_item_id, row.thread_id],
        );
        await tx.query(
          `UPDATE messages SET card=jsonb_set(card,'{workItemId}',to_jsonb($2::text))
           WHERE card_type='work-assignment' AND card->>'workItemId'=$1`,
          [row.work_item_id, row.thread_id],
        );
        await tx.query(`DELETE FROM work_item_threads WHERE work_item_id=$1`, [row.work_item_id]);
        await tx.query(`DELETE FROM work_items WHERE id=$1`, [row.work_item_id]);
      } else {
        await tx.query(`DELETE FROM work_item_threads WHERE work_item_id=$1`, [row.work_item_id]);
      }
    }

    const standalone = (
      await tx.query<{
        id: string;
        room_id: string;
        state: WorkState | null;
        priority: string;
        title: string | null;
        objective: string | null;
        assignee_id: string | null;
        opened_by: string;
        completed_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT w.id,w.room_id::text room_id,w.state,w.priority,w.title,w.objective,w.assignee_id,w.opened_by,w.completed_at,w.created_at,w.updated_at
         FROM work_items w
         WHERE w.source_message_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM rooms t WHERE t.id::text=w.id AND t.parent_id IS NOT NULL)
         ORDER BY w.created_at,w.id`,
      )
    ).rows;
    for (const row of standalone) {
      const normalizedTitle = normalizeWorkTitle(row.title ?? undefined);
      const trailingObjective = row.title ? extractBracketedWorkTitle(row.title).trailing : '';
      const nextObjective =
        !row.objective?.trim() && trailingObjective
          ? (normalizeWorkObjective(trailingObjective) ?? row.objective)
          : row.objective;
      if (!WORK_ITEM_UUID_RE.test(row.id)) {
        const newId = deterministicWorkItemUuid(`work-item-migrate:${row.id}`);
        const already = (
          await tx.query('SELECT 1 FROM work_items WHERE id=$1', [newId])
        ).rowCount;
        if (!already) {
          await updateWorkItem(
            tx,
            {
              roomId: row.room_id,
              id: newId,
              state: row.state ?? 'backlog',
              title: normalizedTitle ?? row.title ?? undefined,
              objective: nextObjective ?? undefined,
              assigneeId: row.assignee_id,
            },
            row.opened_by,
          );
          await tx.query(
            `UPDATE work_items SET priority=$2,opened_by=$3,completed_at=$4,created_at=$5,updated_at=$6 WHERE id=$1`,
            [newId, row.priority, row.opened_by, row.completed_at, row.created_at, row.updated_at],
          );
        }
        await tx.query(
          `UPDATE work_item_entries SET work_item_id=$2 WHERE work_item_id=$1`,
          [row.id, newId],
        );
        await tx.query(
          `UPDATE work_item_attachments SET work_item_id=$2 WHERE work_item_id=$1`,
          [row.id, newId],
        );
        await tx.query(
          `UPDATE messages SET card=jsonb_set(card,'{workItemId}',to_jsonb($2::text))
           WHERE card_type='work-assignment' AND card->>'workItemId'=$1`,
          [row.id, newId],
        );
        await tx.query(`DELETE FROM work_items WHERE id=$1`, [row.id]);
      } else if (
        (normalizedTitle !== undefined && normalizedTitle !== row.title) ||
        nextObjective !== row.objective
      ) {
        await tx.query(
          `UPDATE work_items SET title=COALESCE($2,title),objective=COALESCE($3,objective) WHERE id=$1`,
          [row.id, normalizedTitle ?? null, nextObjective ?? null],
        );
      }
    }

    await tx.query("SELECT set_config('beeline.work_migration','',true)");
  });
}

/**
 * A thread has one state, owned by the corner machine. Its own task row keeps only
 * assignee, title, objective, notes and attachments. Done on a thread is the caller's
 * existing close (`closeThread`); moving an unopened UUID backlog task to In progress
 * promotes it in-place into its thread; moving an open thread to Backlog stops active
 * work and cleans up transient state.
 */
export async function updateWorkItem(
  db: SqlDatabase,
  input: UpdateWorkItemInput,
  actorId: string,
  accessIdentityId = actorId,
  closeOrHooks?: (() => Promise<unknown>) | UpdateWorkItemHooks,
): Promise<void> {
  const hooks: UpdateWorkItemHooks =
    typeof closeOrHooks === 'function' ? { closeThread: closeOrHooks } : (closeOrHooks ?? {});
  if (input.state !== undefined && !WORK_STATES.includes(input.state))
    throw new Error('invalid work state');
  const itemId = input.id ?? input.roomId;
  const thread =
    itemId === input.roomId &&
    ((
      await db.query('SELECT 1 FROM rooms WHERE id::text=$1 AND parent_id IS NOT NULL', [
        input.roomId,
      ])
    ).rowCount ?? 0) > 0;
  if (thread && input.state === 'done' && !hooks.closeThread)
    throw new Error('a thread is marked done only by its close');

  let migrating = false;
  let wasBacklog = false;
  let parkedThread = false;
  let unparkedThread = false;
  let threadParentId: string | null = null;
  let threadName = '';
  let threadObjective = '';
  let threadHasRepo = false;

  await db.transaction(async (tx) => {
    migrating =
      (
        await tx.query<{ migrating: boolean }>(
          "SELECT current_setting('beeline.work_migration',true)='on' AS migrating",
        )
      ).rows[0]?.migrating === true;
    const previous =
      (
        await tx.query<{ actor: string | null }>(
          "SELECT current_setting('beeline.work_actor',true) actor",
        )
      ).rows[0]?.actor ?? '';
    await tx.query("SELECT set_config('beeline.work_actor',$1,true)", [actorId]);

    const room = (
      await tx.query<{
        id: string;
        workspace_id: string;
        parent_id: string | null;
        name: string;
        repository_key: string | null;
        repository_resolution: string | null;
        repository_target_branch: string | null;
      }>(
        `SELECT r.id,r.workspace_id,r.parent_id,r.name,r.repository_key,r.repository_resolution,r.repository_target_branch
         FROM rooms r
         LEFT JOIN room_access member ON member.room_id=r.id AND member.identity_id=$2 AND member.removed_at IS NULL
         WHERE r.id=$1 AND (member.identity_id IS NOT NULL OR $3::boolean)`,
        [input.roomId, accessIdentityId, migrating],
      )
    ).rows[0];
    if (!room) throw new CommandRefusalError('room access denied', 403);

    const existingRow = (
      await tx.query<{
        room_id: string;
        source_message_id: string | null;
        state: WorkState | null;
        title: string | null;
        objective: string | null;
        assignee_id: string | null;
      }>(
        `SELECT room_id::text room_id,source_message_id,state,title,objective,assignee_id
         FROM work_items WHERE id=$1 FOR UPDATE`,
        [itemId],
      )
    ).rows[0];
    if (existingRow && existingRow.room_id !== input.roomId)
      throw new CommandRefusalError('room access denied', 403);

    const isAskMessage =
      Boolean(existingRow?.source_message_id) ||
      ((
        await tx.query('SELECT 1 FROM messages WHERE id=$1 AND room_id=$2', [itemId, input.roomId])
      ).rowCount ?? 0) > 0;

    if (thread && !migrating) {
      const fact = (
        await tx.query<{ machine: CornerMachine | null; parent_has_repo: boolean }>(
          `SELECT f.machine,
                  EXISTS(SELECT 1 FROM rooms p WHERE p.id=$2 AND (p.repository_resolution='repository' OR p.repository_key IS NOT NULL)) parent_has_repo
           FROM corner_facts f WHERE f.corner_id=$1`,
          [input.roomId, room.parent_id],
        )
      ).rows[0];
      wasBacklog = fact?.machine?.backlog === true;
      threadParentId = room.parent_id;
      threadName = room.name;
      threadHasRepo = Boolean(fact?.parent_has_repo);
    }

    const hasAssignee = Object.hasOwn(input, 'assigneeId');
    const resolvedAssigneeId = hasAssignee
      ? await resolveWorkAssigneeId(tx, input.roomId, input.assigneeId)
      : null;
    const titleParts =
      !isAskMessage && input.title !== undefined ? extractBracketedWorkTitle(input.title) : undefined;
    const normalizedTitle = !isAskMessage ? normalizeWorkTitle(input.title) : input.title;
    const effectiveObjectiveInput =
      !isAskMessage &&
      titleParts?.trailing &&
      (input.objective === undefined || input.objective.trim() === '') &&
      !(existingRow?.objective?.trim())
        ? titleParts.trailing
        : input.objective;
    const normalizedObjective = !isAskMessage
      ? normalizeWorkObjective(effectiveObjectiveInput)
      : input.objective;

    const changed = await tx.query<{
      state: WorkState | null;
      title: string | null;
      objective: string | null;
      assignee_id: string | null;
      corner: boolean;
    }>(
      `INSERT INTO work_items(id,room_id,source_message_id,state,title,objective,assignee_id,opened_by,completed_at)
    SELECT $7,r.id,(SELECT id FROM messages source WHERE source.id=$7 AND source.room_id=r.id),
      COALESCE($2,'backlog'),$3,$8,
      CASE WHEN $5 THEN $4 ELSE ${cornerImplementerSql('f', 'r')} END,CASE WHEN $7=r.id::text THEN COALESCE(r.created_by,$6) ELSE COALESCE((SELECT author_id FROM messages source WHERE source.id=$7 AND source.room_id=r.id),$6) END,CASE WHEN $2='done' THEN now() END
    FROM rooms r
    LEFT JOIN room_access member ON member.room_id=r.id AND member.identity_id=$9 AND member.removed_at IS NULL
    LEFT JOIN corner_facts f ON f.corner_id=r.id
    WHERE r.id=$1 AND (member.identity_id IS NOT NULL OR $10::boolean)
    ON CONFLICT(id) DO UPDATE SET state=COALESCE($2,work_items.state),
      title=COALESCE($3,work_items.title),objective=COALESCE($8,work_items.objective),
      assignee_id=CASE WHEN $5 THEN $4 ELSE work_items.assignee_id END,updated_at=now(),
      completed_at=CASE WHEN COALESCE($2,work_items.state)='done' THEN COALESCE(work_items.completed_at,now()) ELSE NULL END WHERE work_items.room_id=$1
    RETURNING state,title,objective,assignee_id,EXISTS(SELECT 1 FROM rooms corner WHERE corner.id=$1 AND corner.parent_id IS NOT NULL) corner`,
      [
        input.roomId,
        input.state ?? null,
        normalizedTitle ?? null,
        resolvedAssigneeId,
        hasAssignee,
        actorId,
        itemId,
        normalizedObjective ?? null,
        accessIdentityId,
        migrating,
      ],
    );
    const item = changed.rows[0];
    if (!item) throw new CommandRefusalError('room access denied', 403);
    threadObjective = item.objective ?? '';

    if (migrating) {
      await tx.query("SELECT set_config('beeline.work_actor',$1,true)", [previous]);
      return;
    }

    if (item.corner && item.objective && (thread ? input.state : item.state) !== 'backlog')
      await writeCornerObjective(tx, input.roomId, item.objective, true);
    if (input.note !== undefined) await addWorkNote(tx, { ...input, text: input.note }, actorId);
    for (const attachment of input.attachments ?? [])
      await attachToWorkItem(tx, { ...input, attachment }, actorId);

    const promoteToThread =
      !thread &&
      !isAskMessage &&
      input.state === 'in-progress' &&
      WORK_ITEM_UUID_RE.test(itemId) &&
      room.parent_id === null;

    if (promoteToThread) {
      await promoteUnopenedTaskToThread(tx, {
        itemId,
        room,
        title: item.title,
        objective: item.objective,
        assigneeId: item.assignee_id,
        actorId,
      });
    } else if (!isAskMessage) {
      if (input.state === 'done' || input.state === 'in-progress') {
        await clearWorkAssignmentMarks(tx, itemId, 'answered');
      }
      if (thread && input.state === 'backlog') {
        parkedThread = true;
        await parkThreadInBacklog(tx, {
          roomId: input.roomId,
          workspaceId: room.workspace_id,
          actorId,
        });
      } else if (thread && input.state !== undefined && input.state !== 'done') {
        unparkedThread = true;
      }

      const assigneeChanged = hasAssignee && resolvedAssigneeId !== (existingRow?.assignee_id ?? null);
      if (assigneeChanged) {
        await clearWorkAssignmentMarks(tx, itemId, 'superseded');
        if (
          resolvedAssigneeId &&
          resolvedAssigneeId !== actorId &&
          input.state !== 'done' &&
          input.state !== 'in-progress'
        ) {
          await notifyWorkAssignment(tx, {
            roomId: input.roomId,
            workItemId: itemId,
            actorId,
            assigneeId: resolvedAssigneeId,
            title: item.title ?? room.name,
            objective: item.objective ?? '',
          });
        }
      }
    }

    await tx.query("SELECT set_config('beeline.work_actor',$1,true)", [previous]);
  });

  if (migrating) return;
  if (thread && input.state === 'done') {
    await hooks.closeThread!();
  } else if (parkedThread) {
    await advanceCorner(db, input.roomId, { kind: 'backlog', backlog: true });
    await hooks.reconcileMergeQueue?.(input.roomId);
  } else if (unparkedThread) {
    await resumeParkedThread(db, {
      roomId: input.roomId,
      wasBacklog,
      state: input.state,
      threadParentId,
      threadName,
      threadObjective,
      threadHasRepo,
      actorId,
    });
  }
}

function workColumnsSql(viewer: string): string {
  return `r.id room_id,CASE WHEN r.direct_participants IS NOT NULL THEN 'direct' WHEN r.parent_id IS NOT NULL THEN 'corner' ELSE 'room' END room_kind,
    (r.archived_at IS NOT NULL) room_archived,COALESCE(p.id,r.id) chat_id,COALESCE(p.name,r.name) chat_name,
    CASE WHEN w.id IS NOT NULL AND w.id<>r.id::text THEN COALESCE(w.title,r.name) ELSE r.name END name,r.name thread_name,
    (r.parent_id IS NOT NULL AND ref.id=r.id::text) thread,
    CASE WHEN r.parent_id IS NOT NULL AND ref.id=r.id::text THEN f.machine END thread_machine,
    blocker.person_id thread_blocker_person,
    CASE WHEN r.parent_id IS NOT NULL AND ref.id=r.id::text THEN NULL
      WHEN r.archived_at IS NOT NULL OR w.state='done' THEN 'done'
      WHEN w.state='backlog' OR w.state IS NULL THEN 'backlog'
      WHEN w.state='needs-you' AND w.assignee_id IS DISTINCT FROM ${viewer} THEN 'in-progress' ELSE w.state END state,
    COALESCE(NULLIF(CASE WHEN r.parent_id IS NOT NULL AND COALESCE(w.id,r.id::text)=r.id::text
      THEN ${cornerObjectiveSql('r')} END,''),w.objective,'') objective,
    row_to_json(assignee) assignee,row_to_json(opener) opener,
    COALESCE(w.created_at,r.created_at) created_at,
    GREATEST(w.updated_at,r.archived_at,r.created_at) updated_at,${workDetailColumnsSql('ref.id')}
    FROM work_refs ref JOIN rooms r ON r.id=ref.room_id
    JOIN room_access a ON a.room_id=COALESCE(r.parent_id,r.id) AND a.identity_id=${viewer} AND a.removed_at IS NULL
    LEFT JOIN rooms p ON p.id=r.parent_id LEFT JOIN work_items w ON w.id=ref.id
    LEFT JOIN corner_facts f ON f.corner_id=r.id
    ${cornerBlockerSql("ref.id=r.id::text AND f.machine->>'state'='waiting'", false, viewer, 'r')}
    JOIN identities opener ON opener.id=COALESCE(w.opened_by,r.created_by,${viewer})
    LEFT JOIN identities assignee ON assignee.id=CASE WHEN w.room_id IS NOT NULL THEN w.assignee_id
      ELSE ${cornerImplementerSql('f', 'r')} END`;
}

/** One server projection shared by desktop and phone; no render-time model call. */
export async function readWorkBoard(
  db: SqlDatabase,
  workspaceId: string,
  viewerId: string,
  publicOrigin = '',
): Promise<WorkBoardView> {
  const workspace = (
    await db.query<{ name: string }>(
      `SELECT w.name FROM workspaces w
    JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL AND m.identity_id=$2 AND m.removed_at IS NULL
    WHERE w.id=$1`,
      [workspaceId, viewerId],
    )
  ).rows[0];
  if (!workspace) throw new CommandRefusalError('workspace membership required', 403);
  const [work, needs, members, chats] = await Promise.all([
    db.query<WorkRow>(
      `WITH work_refs AS (
        SELECT room.id::text id,room.id room_id FROM rooms room WHERE room.workspace_id=$1 AND room.parent_id IS NOT NULL
        UNION SELECT stored.id,stored.room_id FROM work_items stored JOIN rooms room ON room.id=stored.room_id
          WHERE room.workspace_id=$1 AND stored.source_message_id IS NULL
      ) SELECT ref.id,${workColumnsSql('$2')}
      WHERE r.workspace_id=$1 AND (r.parent_id IS NOT NULL OR w.room_id IS NOT NULL)
        AND NOT (f.locked IS TRUE AND ref.id=r.id::text)
        AND (r.archived_at IS NULL OR r.archived_at>=now()-interval '7 days')
        AND (ref.id=r.id::text AND r.parent_id IS NOT NULL OR w.state IS DISTINCT FROM 'done' OR w.completed_at>=now()-interval '7 days')`,
      [workspaceId, viewerId],
    ),
    needsYouItems(
      db,
      workspaceId,
      viewerId,
      (row) => phoneIdentity(row, publicOrigin),
      undefined,
      publicOrigin,
    ),
    db.query<PhoneIdentityRow>(
      `SELECT i.*,beeline_workspace_handle(i.id,$1) handle FROM identities i
      JOIN memberships m ON m.identity_id=i.id AND m.workspace_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL
      WHERE COALESCE(i.hidden_from_roster,false)=false ORDER BY i.kind,i.name`,
      [workspaceId],
    ),
    db.query<{ id: string; name: string }>(
      `SELECT r.id,r.name FROM rooms r JOIN room_access a
      ON a.room_id=COALESCE(r.parent_id,r.id) AND a.identity_id=$2 AND a.removed_at IS NULL WHERE r.workspace_id=$1
      AND r.parent_id IS NULL AND r.direct_participants IS NULL AND r.archived_at IS NULL ORDER BY r.name`,
      [workspaceId, viewerId],
    ),
  ]);
  const identities = members.rows.map((row) => phoneIdentity(row, publicOrigin));
  const viewer = identities.find((person) => person.pubkey === viewerId)!;
  const questions = needs.items.length
    ? await db.query<
        WorkDetailRow & {
          message_id: string;
          message_text: string;
          card_type: string | null;
          work_item_id: string | null;
          assignment_title: string | null;
          assignment_objective: string | null;
          report_digest: boolean;
          question: string | null;
          brief: string | null;
          source: WorkItemView['source'] | null;
          recommended_option_id: string | null;
        }
      >(
        `SELECT source.id message_id,source.text message_text,source.card_type,
           source.card->>'workItemId' work_item_id,
           source.card->>'title' assignment_title,
           source.card->>'objective' assignment_objective,
           q.message_id IS NULL AND source.card->>'reportToId' IS NOT NULL report_digest,
           COALESCE(q.question,CASE WHEN source.card->>'reportToId' IS NOT NULL THEN source.card->>'question' END) question,
           COALESCE(q.brief,CASE WHEN source.card->>'reportToId' IS NOT NULL THEN source.card->>'brief' END) brief,q.recommended_option_id,${workDetailColumnsSql('source.id')},
           CASE WHEN source.card->'route' IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
             'roomId',origin.id,'messageId',CASE WHEN q.about->>'kind'='request' AND EXISTS(SELECT 1 FROM messages task
               WHERE task.id=q.about->>'messageId' AND task.room_id=origin.id) THEN q.about->>'messageId' END,
             'label',CASE WHEN origin.parent_id IS NOT NULL THEN '#' || parent.name || ' ↳ ' || origin.name
               WHEN origin.direct_participants IS NOT NULL THEN 'DM' ELSE '#' || origin.name END)) END source
         FROM messages source LEFT JOIN work_questions q ON q.message_id=source.id
         LEFT JOIN rooms origin ON origin.id::text=q.about->>'roomId'
         LEFT JOIN rooms parent ON parent.id=origin.parent_id WHERE source.id=ANY($1::text[])`,
        [needs.items.map((item) => item.messageId)],
      )
    : { rows: [] };
  const questionById = new Map(questions.rows.map((q) => [q.message_id, q]));
  const items: WorkItemView[] = work.rows.map((row) => projectWorkRow(row, publicOrigin, viewerId));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const threads = new Map(
    items.filter((item) => item.id === item.roomId).map((item) => [item.roomId, item]),
  );
  const askingRooms = new Set(needs.items.map((ask) => ask.roomId));
  const asks = needs.items.map((ask): WorkItemView => {
    const thread = threads.get(ask.roomId);
    const q = questionById.get(ask.messageId);
    const assignedItem =
      q?.card_type === 'work-assignment' && q.work_item_id ? itemsById.get(q.work_item_id) : undefined;
    const assignmentSource: WorkItemView['source'] | undefined =
      q?.card_type === 'work-assignment'
        ? {
            roomId: assignedItem?.roomId ?? ask.roomId,
            label: `#${ask.parentRoomName ?? ask.roomName} ↳ ${q.assignment_title || assignedItem?.title || ask.roomName}`,
          }
        : undefined;
    return {
      ...(assignedItem
        ? withoutIdle(assignedItem)
        : thread
          ? withoutIdle(thread)
          : {
              chatId: ask.roomKind === 'corner' ? '' : ask.roomId,
              chatName: ask.parentRoomName ?? ask.roomName,
              title: q?.assignment_title || ask.roomName,
              threadName: q?.assignment_title || ask.roomName,
              priority: 'none' as const,
              ...(q?.assignment_objective ? { objective: q.assignment_objective } : {}),
              openedBy: ask.author ?? viewer,
              createdAt: ask.createdAt,
              updatedAt: ask.createdAt,
            }),
      ...(q && q.card_type !== 'work-assignment' ? projectWorkDetail(q, publicOrigin) : {}),
      id: ask.messageId,
      roomId: ask.roomId,
      roomKind: ask.roomKind,
      state: 'needs-you',
      assignee: viewer,
      messageId: ask.messageId,
      ask:
        q && (q.question || q.brief || ask.approval?.kind === 'choice')
          ? {
              ...ask,
              text: q.report_digest
                ? q.question || needsYouRowText(q.message_text, viewer.handle ?? null)
                : q.question && q.brief
                  ? `${q.question}\n\n${q.brief}`
                  : q.question && ask.approval?.actions?.some((action) => action.kind === 'choice')
                    ? q.question
                    : q.message_text || q.question || ask.text,
              approval: ask.approval
                ? { ...ask.approval, subject: q.question || ask.approval.subject }
                : undefined,
            }
          : ask,
      askIds: [ask.messageId],
      ...(q?.brief ? { brief: q.brief } : {}),
      ...(q?.source ? { source: q.source } : assignmentSource ? { source: assignmentSource } : {}),
      ...(q?.recommended_option_id ? { recommendedOptionId: q.recommended_option_id } : {}),
    };
  });
  const rest = items.filter((item) => !(item.id === item.roomId && askingRooms.has(item.roomId)));
  rest.sort(
    (a, b) =>
      Number(Boolean(a.idle)) - Number(Boolean(b.idle)) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  return {
    workspaceId,
    workspaceName: workspace.name,
    viewerId,
    items: [...asks, ...rest],
    chats: chats.rows,
    people: identities,
  };
}

/** Accessible tasks for an agent: addressed chat, thread, or workspace when omitted/DM. */
export async function readWorkItemsForAgent(
  db: SqlDatabase,
  agentId: string,
  input: { roomId?: string; state?: WorkState } = {},
  publicOrigin = '',
): Promise<{ tasks: WorkItemView[] }> {
  if (input.state !== undefined && !WORK_STATES.includes(input.state))
    throw new CommandRefusalError('invalid work state', 400);
  let workspaceIds: string[];
  let scopeChatId: string | null = null;
  let scopeThreadId: string | null = null;
  if (input.roomId) {
    const ws = await workBoardScope(db, input.roomId, agentId);
    if (!ws) throw new CommandRefusalError('room access denied', 403);
    workspaceIds = [ws];
    const room = (
      await db.query<{ parent_id: string | null; direct: boolean }>(
        'SELECT parent_id,direct_participants IS NOT NULL direct FROM rooms WHERE id=$1',
        [input.roomId],
      )
    ).rows[0];
    if (room?.parent_id) scopeThreadId = input.roomId;
    else if (room && !room.direct) scopeChatId = input.roomId;
  } else {
    workspaceIds = (
      await db.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM memberships WHERE room_id IS NULL AND identity_id=$1 AND removed_at IS NULL`,
        [agentId],
      )
    ).rows.map((r) => r.workspace_id);
    if (!workspaceIds.length) return { tasks: [] };
  }
  const rows = (
    await db.query<WorkRow>(
      `WITH work_refs AS (
        SELECT room.id::text id,room.id room_id FROM rooms room
          WHERE room.workspace_id=ANY($1::uuid[]) AND room.parent_id IS NOT NULL
        UNION SELECT stored.id,stored.room_id FROM work_items stored JOIN rooms room ON room.id=stored.room_id
          WHERE room.workspace_id=ANY($1::uuid[]) AND stored.source_message_id IS NULL
      ) SELECT ref.id,${workColumnsSql('$2')}
      WHERE r.workspace_id=ANY($1::uuid[]) AND (r.parent_id IS NOT NULL OR w.room_id IS NOT NULL)
        AND NOT (f.locked IS TRUE AND ref.id=r.id::text)
        AND ($3::uuid IS NULL OR COALESCE(r.parent_id,r.id)=$3)
        AND ($4::uuid IS NULL OR r.id=$4)
        AND (r.archived_at IS NULL OR r.archived_at>=now()-interval '7 days')
        AND (ref.id=r.id::text AND r.parent_id IS NOT NULL OR w.state IS DISTINCT FROM 'done' OR w.completed_at>=now()-interval '7 days')`,
      [workspaceIds, agentId, scopeChatId, scopeThreadId],
    )
  ).rows;
  let tasks = rows.map((row) => projectWorkRow(row, publicOrigin, agentId));
  if (input.state !== undefined) tasks = tasks.filter((item) => item.state === input.state);
  tasks.sort(
    (a, b) =>
      Number(Boolean(a.idle)) - Number(Boolean(b.idle)) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  return { tasks };
}

/** Bounded open backlog tasks for one chat, attached to room turn context. */
export async function readOpenBacklogTasks(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  limit = 15,
): Promise<OpenBacklogTask[]> {
  const rows = (
    await db.query<{
      id: string;
      chat_name: string;
      name: string;
      objective: string;
      assignee_handle: string | null;
      assignee_name: string | null;
    }>(
      `WITH chat AS (
         SELECT r.id,r.workspace_id,r.name FROM rooms r
         JOIN room_access a ON a.room_id=r.id AND a.identity_id=$2 AND a.removed_at IS NULL
         WHERE r.id=$1 AND r.parent_id IS NULL AND r.direct_participants IS NULL AND r.archived_at IS NULL
       ), backlog_rows AS (
         SELECT w.id,chat.name chat_name,COALESCE(w.title,chat.name) name,COALESCE(w.objective,'') objective,
           w.assignee_id,w.updated_at,chat.workspace_id
         FROM chat
         JOIN work_items w ON w.room_id=chat.id AND w.source_message_id IS NULL
           AND (w.state='backlog' OR w.state IS NULL)
         UNION ALL
         SELECT t.id::text id,chat.name chat_name,t.name,COALESCE(NULLIF(${cornerObjectiveSql('t')},''),w.objective,'') objective,
           COALESCE(w.assignee_id,${cornerImplementerSql('f', 't')}) assignee_id,
           GREATEST(w.updated_at,t.created_at) updated_at,chat.workspace_id
         FROM chat
         JOIN rooms t ON t.parent_id=chat.id AND t.archived_at IS NULL
         JOIN corner_facts f ON f.corner_id=t.id AND f.locked IS NOT TRUE AND f.machine->>'backlog'='true'
         LEFT JOIN work_items w ON w.id=t.id::text
       )
       SELECT b.id,b.chat_name,b.name,b.objective,
         CASE WHEN b.assignee_id IS NOT NULL THEN beeline_workspace_handle(b.assignee_id,b.workspace_id) END assignee_handle,
         assignee.name assignee_name
       FROM backlog_rows b
       LEFT JOIN identities assignee ON assignee.id=b.assignee_id
       ORDER BY b.updated_at DESC,b.id
       LIMIT $3`,
      [roomId, agentId, limit],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    title: cornerShortTitle(row.chat_name, row.name, row.id),
    ...(row.objective ? { objective: row.objective } : {}),
    ...(row.assignee_handle ? { assigneeHandle: row.assignee_handle } : {}),
    ...(row.assignee_name ? { assigneeName: row.assignee_name } : {}),
  }));
}

/** Thread detail uses the same fields without loading the Workspace board. */
export async function readWorkThread(
  db: SqlDatabase,
  roomId: string,
  viewerId: string,
  publicOrigin = '',
): Promise<WorkItemView[]> {
  const rows = (
    await db.query<WorkRow>(
      `WITH work_refs AS (SELECT thread.id::text id,thread.id room_id FROM rooms thread WHERE thread.id=$1)
      SELECT ref.id,${workColumnsSql('$2')} WHERE r.parent_id IS NOT NULL`,
      [roomId, viewerId],
    )
  ).rows;
  return rows.map((row) => projectWorkRow(row, publicOrigin, viewerId));
}

function withoutIdle(item: WorkItemView): WorkItemView {
  const copy = { ...item };
  delete (copy as { idle?: true }).idle;
  return copy;
}

function projectWorkRow(row: WorkRow, publicOrigin: string, viewerId: string): WorkItemView {
  const machine = row.thread_machine;
  const threadState = row.thread
    ? threadWorkState(
        {
          state: machine?.state ?? 'idle',
          ...(machine?.state === 'idle' && machine.reason ? { reason: machine.reason } : {}),
          ...(machine?.state === 'waiting' && row.thread_blocker_person
            ? { blocker: { kind: 'message' as const, personId: row.thread_blocker_person } }
            : {}),
        },
        viewerId,
      )
    : undefined;
  const mark = threadState
    ? {
        state: threadState,
        idle: threadState === 'in-progress' && (machine?.state ?? 'idle') === 'idle',
      }
    : { state: row.state ?? 'backlog', idle: false };
  return {
    ...projectWorkDetail(row, publicOrigin),
    id: row.id,
    roomId: row.room_id,
    roomKind: row.room_kind,
    chatId: row.chat_id,
    chatName: row.chat_name,
    title: row.thread
      ? cornerShortTitle(row.chat_name, row.name, row.room_id)
      : cornerShortTitle(row.chat_name, row.name, row.id),
    threadName:
      row.chat_id !== row.room_id
        ? cornerShortTitle(row.chat_name, row.thread_name, row.room_id)
        : cornerShortTitle(row.chat_name, row.name, row.id),
    state: mark.state,
    ...(row.room_archived ? { roomArchived: true as const } : {}),
    priority: 'none',
    ...(mark.idle ? { idle: true as const } : {}),
    ...(row.objective ? { objective: row.objective } : {}),
    openedBy: phoneIdentity(row.opener, publicOrigin),
    assignee: row.assignee ? phoneIdentity(row.assignee, publicOrigin) : null,
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    updatedAt: Math.floor(row.updated_at.getTime() / 1000),
  };
}
