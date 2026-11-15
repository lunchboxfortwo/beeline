import {
  cornerShortTitle,
  WORK_PRIORITIES,
  WORK_STATES,
  type UpdateWorkItemInput,
  type WorkBoardView,
  type WorkItemView,
  type WorkPriority,
  type WorkState,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { phoneIdentity, type PhoneIdentityRow } from './phone-identity.js';
import { needsYouItems } from './needs-you.js';
import { cornerImplementerSql } from './corner-worker.js';
import { CommandRefusalError } from './command-refusal.js';

type WorkRow = {
  id: string;
  room_id: string;
  room_kind: 'direct' | 'room' | 'corner';
  source_message_id: string | null;
  chat_id: string;
  chat_name: string;
  name: string;
  thread_name: string;
  state: WorkState;
  priority: WorkPriority;
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
): Promise<void> {
  if (
    (input.state !== undefined && !WORK_STATES.includes(input.state)) ||
    (input.priority !== undefined && !WORK_PRIORITIES.includes(input.priority))
  )
    throw new Error('invalid work state or priority');
  // Assignment is one field. Null is an intentional unassignment.
  const changed = await db.query(
    `INSERT INTO work_items(id,room_id,source_message_id,state,priority,title,assignee_id,opened_by,completed_at)
    SELECT $8,r.id,(SELECT id FROM messages source WHERE source.id=$8 AND source.room_id=r.id),COALESCE($2,CASE f.machine->>'state' WHEN 'working' THEN 'in-progress' WHEN 'review' THEN 'in-review' WHEN 'waiting' THEN 'needs-you' ELSE 'backlog' END),COALESCE($3,'none'),$4,
      CASE WHEN $6 THEN $5 ELSE ${cornerImplementerSql('f', 'r')} END,CASE WHEN $8=r.id::text THEN COALESCE(r.created_by,$7) ELSE COALESCE((SELECT author_id FROM messages source WHERE source.id=$8 AND source.room_id=r.id),$7) END,CASE WHEN $2='done' THEN now() END
    FROM rooms r JOIN room_access member ON member.room_id=r.id AND member.identity_id=$7 AND member.removed_at IS NULL
    LEFT JOIN corner_facts f ON f.corner_id=r.id WHERE r.id=$1
    ON CONFLICT(id) DO UPDATE SET state=COALESCE($2,work_items.state),
      priority=COALESCE($3,work_items.priority),title=COALESCE($4,work_items.title),
      assignee_id=CASE WHEN $6 THEN $5 ELSE work_items.assignee_id END,updated_at=now(),
      completed_at=CASE WHEN COALESCE($2,work_items.state)='done' THEN COALESCE(work_items.completed_at,now()) ELSE NULL END WHERE work_items.room_id=$1`,
    [
      input.roomId,
      input.state ?? null,
      input.priority ?? null,
      input.title ?? null,
      input.assigneeId ?? null,
      Object.hasOwn(input, 'assigneeId'),
      actorId,
      input.id ?? input.roomId,
    ],
  );
  if (!changed.rowCount) throw new CommandRefusalError('room access denied', 403);
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
        UNION SELECT stored.id,stored.room_id FROM work_items stored JOIN rooms room ON room.id=stored.room_id WHERE room.workspace_id=$1
      ) SELECT ref.id,r.id room_id,CASE WHEN r.direct_participants IS NOT NULL THEN 'direct' WHEN r.parent_id IS NOT NULL THEN 'corner' ELSE 'room' END room_kind,w.source_message_id,COALESCE(p.id,r.id) chat_id,COALESCE(p.name,r.name) chat_name,
      COALESCE(w.title,q.question,r.name) name,r.name thread_name,
      CASE WHEN r.archived_at IS NOT NULL THEN 'done' ELSE COALESCE(w.state,CASE
        WHEN f.machine->>'state'='waiting' THEN 'needs-you'
        WHEN f.machine->>'state'='review' THEN 'in-review'
        WHEN f.machine->>'state'='working' THEN 'in-progress' ELSE 'backlog' END) END state,
      COALESCE(w.priority,'none') priority,row_to_json(assignee) assignee,row_to_json(opener) opener,
      COALESCE(w.created_at,r.created_at) created_at,
      GREATEST(w.updated_at,r.archived_at,r.created_at) updated_at
      FROM work_refs ref JOIN rooms r ON r.id=ref.room_id JOIN room_access a ON a.room_id=COALESCE(r.parent_id,r.id) AND a.identity_id=$2 AND a.removed_at IS NULL
      LEFT JOIN rooms p ON p.id=r.parent_id LEFT JOIN work_items w ON w.id=ref.id
      LEFT JOIN work_questions q ON q.message_id=w.source_message_id
      LEFT JOIN corner_facts f ON f.corner_id=r.id
      JOIN identities opener ON opener.id=COALESCE(w.opened_by,r.created_by,$2)
      LEFT JOIN identities assignee ON assignee.id=CASE WHEN w.room_id IS NOT NULL THEN w.assignee_id
        ELSE ${cornerImplementerSql('f', 'r')} END
      WHERE r.workspace_id=$1 AND (r.parent_id IS NOT NULL OR w.room_id IS NOT NULL)
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
    ? await db.query<{
        message_id: string;
        question: string;
        recommended_option_id: string | null;
      }>(
        `SELECT message_id,question,recommended_option_id FROM work_questions WHERE message_id=ANY($1::text[])`,
        [needs.items.map((item) => item.messageId)],
      )
    : { rows: [] };
  const questionById = new Map(questions.rows.map((q) => [q.message_id, q]));
  const needItems = needs.items;
  const items: WorkItemView[] = work.rows.map((row) => projectWorkRow(row, publicOrigin));
  const byId = new Map(items.map((item) => [item.id, item]));
  const byRoom = new Map(
    items.filter((item) => item.id === item.roomId).map((item) => [item.roomId, item]),
  );
  const activeAsks = new Set(needItems.map((ask) => ask.messageId));
  const asks = needItems.map((ask): WorkItemView => {
    const task = byId.get(ask.messageId) ?? byRoom.get(ask.roomId);
    const q = questionById.get(ask.messageId);
    return {
      ...(task ?? {
        chatId: ask.roomKind === 'corner' ? '' : ask.roomId,
        chatName: ask.parentRoomName ?? ask.roomName,
        title: ask.roomName,
        threadName: ask.roomName,
        priority: 'none' as const,
        openedBy: ask.author ?? viewer,
        createdAt: ask.createdAt,
        updatedAt: ask.createdAt,
      }),
      id: ask.messageId,
      roomId: ask.roomId,
      roomKind: ask.roomKind,
      state: 'needs-you',
      assignee: viewer,
      openedBy: byId.get(ask.messageId)?.openedBy ?? ask.author ?? viewer,
      messageId: ask.messageId,
      ask: q
        ? {
            ...ask,
            text: q.question,
            approval: ask.approval ? { ...ask.approval, subject: q.question } : undefined,
          }
        : ask,
      ...(q?.recommended_option_id ? { recommendedOptionId: q.recommended_option_id } : {}),
    };
  });
  const all = [...asks, ...items.filter((item) => !activeAsks.has(item.id))];
  all.sort(
    (a, b) =>
      WORK_PRIORITIES.indexOf(a.priority) - WORK_PRIORITIES.indexOf(b.priority) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  return {
    workspaceId,
    workspaceName: workspace.name,
    viewerId,
    items: all,
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
      `SELECT COALESCE(w.id,r.id::text) id,r.id room_id,'corner' room_kind,w.source_message_id,p.id chat_id,p.name chat_name,COALESCE(w.title,q.question,r.name) name,r.name thread_name,
    CASE WHEN r.archived_at IS NOT NULL THEN 'done' ELSE COALESCE(w.state,CASE f.machine->>'state' WHEN 'working' THEN 'in-progress' WHEN 'review' THEN 'in-review'
      WHEN 'waiting' THEN 'needs-you' ELSE 'backlog' END) END state,COALESCE(w.priority,'none') priority,
    row_to_json(opener) opener,row_to_json(assignee) assignee,COALESCE(w.created_at,r.created_at) created_at,
    COALESCE(w.updated_at,r.updated_at) updated_at FROM rooms r JOIN rooms p ON p.id=r.parent_id
    JOIN room_access a ON a.room_id=COALESCE(r.parent_id,r.id) AND a.identity_id=$2 AND a.removed_at IS NULL
    LEFT JOIN work_items w ON w.room_id=r.id LEFT JOIN work_questions q ON q.message_id=w.source_message_id LEFT JOIN corner_facts f ON f.corner_id=r.id
    JOIN identities opener ON opener.id=COALESCE(w.opened_by,r.created_by,$2)
    LEFT JOIN identities assignee ON assignee.id=CASE WHEN w.room_id IS NOT NULL THEN w.assignee_id
      ELSE ${cornerImplementerSql('f', 'r')} END WHERE r.id=$1`,
      [roomId, viewerId],
    )
  ).rows;
  return rows.map((row) => projectWorkRow(row, publicOrigin));
}

function projectWorkRow(row: WorkRow, publicOrigin: string): WorkItemView {
  return {
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
    priority: row.priority,
    openedBy: phoneIdentity(row.opener, publicOrigin),
    assignee: row.assignee ? phoneIdentity(row.assignee, publicOrigin) : null,
    ...(row.source_message_id ? { messageId: row.source_message_id } : {}),
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    updatedAt: Math.floor(row.updated_at.getTime() / 1000),
  };
}
