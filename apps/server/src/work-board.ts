import {
  cornerShortTitle,
  WORK_STATES,
  type UpdateWorkItemInput,
  type WorkBoardView,
  type WorkItemView,
  type WorkState,
} from '@beeline/api-contract/phone';
import { workDetailColumnsSql, projectWorkDetail, addWorkNote,attachToWorkItem,type WorkDetailRow } from './work-item-detail.js';
import type { SqlDatabase } from './database.js';
import { phoneIdentity, type PhoneIdentityRow } from './phone-identity.js';
import { needsYouItems } from './needs-you.js';
import { cornerImplementerSql } from './corner-worker.js';
import { cornerObjectiveSql, writeCornerObjective } from './corner-objective.js';
import { CommandRefusalError } from './command-refusal.js';

type WorkRow = WorkDetailRow & {
  id: string;
  room_id: string;
  room_kind: 'direct' | 'room' | 'corner';
  chat_id: string;
  chat_name: string;
  name: string;
  thread_name: string;
  state: WorkState;
  idle: boolean;
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

export async function updateWorkItem(
  db: SqlDatabase,
  input: UpdateWorkItemInput,
  actorId: string,
  accessIdentityId=actorId,
): Promise<void> {
  if (input.state !== undefined && !WORK_STATES.includes(input.state))
    throw new Error('invalid work state');
  await db.transaction(async (tx) => {
    const previous =
      (
        await tx.query<{ actor: string | null }>(
          "SELECT current_setting('beeline.work_actor',true) actor",
        )
      ).rows[0]?.actor ?? '';
    await tx.query("SELECT set_config('beeline.work_actor',$1,true)", [actorId]);
    // Assignment is one field. Null is an intentional unassignment.
    const changed = await tx.query<{ state: WorkState; objective: string | null; corner: boolean }>(
      `INSERT INTO work_items(id,room_id,source_message_id,state,title,objective,assignee_id,opened_by,completed_at)
    SELECT $7,r.id,(SELECT id FROM messages source WHERE source.id=$7 AND source.room_id=r.id),
      -- A thread's own item is in progress until set otherwise; new work starts in Backlog.
      COALESCE($2,CASE WHEN $7=r.id::text AND r.parent_id IS NOT NULL THEN 'in-progress' ELSE 'backlog' END),$3,$8,
      CASE WHEN $5 THEN $4 ELSE ${cornerImplementerSql('f', 'r')} END,CASE WHEN $7=r.id::text THEN COALESCE(r.created_by,$6) ELSE COALESCE((SELECT author_id FROM messages source WHERE source.id=$7 AND source.room_id=r.id),$6) END,CASE WHEN $2='done' THEN now() END
    FROM rooms r JOIN room_access member ON member.room_id=r.id AND member.identity_id=$9 AND member.removed_at IS NULL
    LEFT JOIN corner_facts f ON f.corner_id=r.id WHERE r.id=$1
    ON CONFLICT(id) DO UPDATE SET state=COALESCE($2,work_items.state),
      title=COALESCE($3,work_items.title),objective=COALESCE($8,work_items.objective),
      assignee_id=CASE WHEN $5 THEN $4 ELSE work_items.assignee_id END,updated_at=now(),
      completed_at=CASE WHEN COALESCE($2,work_items.state)='done' THEN COALESCE(work_items.completed_at,now()) ELSE NULL END WHERE work_items.room_id=$1
    RETURNING state,objective,EXISTS(SELECT 1 FROM rooms corner WHERE corner.id=$1 AND corner.parent_id IS NOT NULL) corner`,
      [
        input.roomId,
        input.state ?? null,
        input.title ?? null,
        input.assigneeId ?? null,
        Object.hasOwn(input, 'assigneeId'),
        actorId,
        input.id ?? input.roomId,
        input.objective ?? null,
        accessIdentityId,
      ],
    );
    const item = changed.rows[0];
    if (!item) throw new CommandRefusalError('room access denied', 403);
    // Started work carries its objective into the thread it runs in, unless the thread has its own.
    if (item.corner && item.objective && item.state !== 'backlog')
      await writeCornerObjective(tx, input.roomId, item.objective, true);
    if (input.note!==undefined) await addWorkNote(tx,{...input,text:input.note},actorId);
    for (const attachment of input.attachments ?? []) await attachToWorkItem(tx,{...input,attachment},actorId);
    await tx.query("SELECT set_config('beeline.work_actor',$1,true)", [previous]);
  });
}

/**
 * Board columns for `rooms r` with optional `w` (its work item), `p` (parent) and `f` (corner facts).
 * A corner's live machine places it in progress; only a stored Backlog or Done moves it.
 * An open thread with nothing running stays In progress as idle.
 */
function workColumnsSql(viewer: string): string {
  return `r.id room_id,CASE WHEN r.direct_participants IS NOT NULL THEN 'direct' WHEN r.parent_id IS NOT NULL THEN 'corner' ELSE 'room' END room_kind,
    COALESCE(p.id,r.id) chat_id,COALESCE(p.name,r.name) chat_name,
    CASE WHEN w.id IS NOT NULL AND w.id<>r.id::text THEN COALESCE(w.title,r.name) ELSE r.name END name,r.name thread_name,
    CASE WHEN r.archived_at IS NOT NULL OR w.state='done' THEN 'done'
      WHEN w.state='backlog' OR (r.parent_id IS NULL AND w.state IS NULL) THEN 'backlog'
      WHEN r.parent_id IS NULL OR w.id<>r.id::text THEN w.state
      WHEN f.machine->>'state'='waiting' THEN 'needs-you'
      WHEN f.machine->>'state'='review' THEN 'in-review' ELSE 'in-progress' END state,
    (r.parent_id IS NOT NULL AND r.archived_at IS NULL AND COALESCE(w.id,r.id::text)=r.id::text
      AND w.state IS DISTINCT FROM 'backlog' AND w.state IS DISTINCT FROM 'done'
      AND COALESCE(f.machine->>'state','idle') NOT IN ('working','review','waiting')) idle,
    COALESCE(NULLIF(CASE WHEN r.parent_id IS NOT NULL AND COALESCE(w.id,r.id::text)=r.id::text
      THEN ${cornerObjectiveSql('r')} END,''),w.objective,'') objective,
    row_to_json(assignee) assignee,row_to_json(opener) opener,
    COALESCE(w.created_at,r.created_at) created_at,
    GREATEST(w.updated_at,r.archived_at,r.created_at) updated_at,${workDetailColumnsSql('ref.id')}
    FROM work_refs ref JOIN rooms r ON r.id=ref.room_id
    JOIN room_access a ON a.room_id=COALESCE(r.parent_id,r.id) AND a.identity_id=${viewer} AND a.removed_at IS NULL
    LEFT JOIN rooms p ON p.id=r.parent_id LEFT JOIN work_items w ON w.id=ref.id
    LEFT JOIN corner_facts f ON f.corner_id=r.id
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
    // Asks are not tasks: an ask-backed item reaches the board only through Needs you.
    db.query<WorkRow>(
      `WITH work_refs AS (
        SELECT room.id::text id,room.id room_id FROM rooms room WHERE room.workspace_id=$1 AND room.parent_id IS NOT NULL
        UNION SELECT stored.id,stored.room_id FROM work_items stored JOIN rooms room ON room.id=stored.room_id
          WHERE room.workspace_id=$1 AND stored.source_message_id IS NULL
      ) SELECT ref.id,${workColumnsSql('$2')}
      WHERE r.workspace_id=$1 AND (r.parent_id IS NOT NULL OR w.room_id IS NOT NULL)
        -- A standing (locked) corner is a place, not a task; its asks still reach Needs you.
        AND NOT (f.locked IS TRUE AND ref.id=r.id::text)
        AND (r.archived_at IS NULL OR r.archived_at>=now()-interval '7 days')
        AND (w.state IS DISTINCT FROM 'done' OR w.completed_at>=now()-interval '7 days')`,
      [workspaceId, viewerId],
    ),
    needsYouItems(
      db,
      workspaceId,
      viewerId,
      (row) => phoneIdentity(row, publicOrigin),
      false,
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
          question: string | null;
          source: WorkItemView['source'] | null;
          recommended_option_id: string | null;
        }
      >(
        `SELECT source.id message_id,q.question,q.recommended_option_id,${workDetailColumnsSql('source.id')},
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
  const items: WorkItemView[] = work.rows.map((row) => projectWorkRow(row, publicOrigin));
  const threads = new Map(
    items.filter((item) => item.id === item.roomId).map((item) => [item.roomId, item]),
  );
  // One Needs you row per thread: the thread itself, carrying its first ask and the count.
  const askingRooms=new Set(needs.items.map(ask=>ask.roomId));
  const asks = needs.items.map((ask): WorkItemView => {
    const thread = threads.get(ask.roomId);
    const q = questionById.get(ask.messageId);
    return {
      ...(thread
        ? withoutIdle(thread)
        : {
            chatId: ask.roomKind === 'corner' ? '' : ask.roomId,
            chatName: ask.parentRoomName ?? ask.roomName,
            title: ask.roomName,
            threadName: ask.roomName,
            priority: 'none' as const,
            openedBy: ask.author ?? viewer,
            createdAt: ask.createdAt,
            updatedAt: ask.createdAt,
          }),
      ...(q ? projectWorkDetail(q, publicOrigin) : {}),
      id: ask.messageId,
      roomId: ask.roomId,
      roomKind: ask.roomKind,
      state: 'needs-you',
      assignee: viewer,
      messageId: ask.messageId,
      ask: q?.question
        ? {
            ...ask,
            text: q.question,
            approval: ask.approval ? { ...ask.approval, subject: q.question } : undefined,
          }
        : ask,
      askIds: [ask.messageId],
      ...(q?.source ? {source:q.source} : {}),
      ...(q?.recommended_option_id ? { recommendedOptionId: q.recommended_option_id } : {}),
    };
  });
  const rest = items.filter((item) => !(item.id === item.roomId && askingRooms.has(item.roomId)));
  // Active work before idle threads, each newest first.
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
  return rows.map((row) => projectWorkRow(row, publicOrigin));
}

function withoutIdle(item: WorkItemView): WorkItemView {
  const copy = { ...item };
  delete (copy as { idle?: true }).idle;
  return copy;
}

function projectWorkRow(row: WorkRow, publicOrigin: string): WorkItemView {
  return {
    ...projectWorkDetail(row, publicOrigin),
    id: row.id,
    roomId: row.room_id,
    roomKind: row.room_kind,
    chatId: row.chat_id,
    chatName: row.chat_name,
    title:
      row.name === row.thread_name && row.chat_id !== row.room_id
        ? cornerShortTitle(row.chat_name, row.name, row.room_id)
        : row.name,
    threadName:
      row.chat_id !== row.room_id
        ? cornerShortTitle(row.chat_name, row.thread_name, row.room_id)
        : row.thread_name,
    state: row.state,
    priority: 'none',
    ...(row.idle ? { idle: true as const } : {}),
    ...(row.objective ? { objective: row.objective } : {}),
    openedBy: phoneIdentity(row.opener, publicOrigin),
    assignee: row.assignee ? phoneIdentity(row.assignee, publicOrigin) : null,
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    updatedAt: Math.floor(row.updated_at.getTime() / 1000),
  };
}
