import { createHash, randomBytes } from 'node:crypto';
import { fixCornerText, type CornerBriefAttachment } from '@beeline/api-contract/daemon';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import {
  cornerShortTitle,
  WORK_STATES,
  type UpdateWorkItemInput,
  type WorkState,
} from '@beeline/api-contract/phone';
import { addWorkNote, attachToWorkItem } from './work-item-detail.js';
import type { SqlDatabase } from './database.js';
import { cornerImplementerSql } from './corner-worker.js';
import { writeCornerObjective } from './corner-objective.js';
import { CommandRefusalError } from './command-refusal.js';
import {
  advanceCorner,
  becomeThreadImplementer,
  cancelCornerAgentCommands,
  createCornerFacts,
  lockCornerLifecycle,
  type CornerMachine,
} from './corner-lifecycle.js';
import { createAgentCommand } from './agent-command.js';
import { cornerBriefRevisionHash } from './corner-brief.js';
import { humanReportCornerSql } from './corner-waiting-report.js';
import { modelText } from './message-origin.js';
import { systemLine } from './system-line.js';
import { abandonCornerWorkflowRuns } from './workflow-runs.js';

export const WORK_ITEM_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deterministicWorkItemUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function extractBracketedWorkTitle(raw: string): { slugSource: string; trailing: string } {
  const trimmed = raw.trim();
  const match = /^\[([^\]]+)\](?:\s+(.*))?$/s.exec(trimmed);
  if (match && match[1]!.trim()) {
    return { slugSource: match[1]!.trim(), trailing: (match[2] ?? '').trim() };
  }
  return { slugSource: trimmed, trailing: '' };
}

export function normalizeWorkTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const { slugSource } = extractBracketedWorkTitle(trimmed);
  try {
    const fixed = fixCornerText('name', slugSource).text;
    return fixed || slugSource;
  } catch {
    return slugSource;
  }
}

export function normalizeWorkObjective(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return fixCornerText('objective', trimmed).text;
}

export type UpdateWorkItemHooks = {
  closeThread?: () => Promise<unknown>;
  reconcileMergeQueue?: (cornerId: string) => Promise<void>;
};

/** Resolve an identity ID or @handle against current workspace/chat members. */
async function resolveWorkAssigneeId(
  tx: SqlDatabase,
  roomId: string,
  rawAssignee: string | null | undefined,
): Promise<string | null> {
  if (rawAssignee === null || rawAssignee === undefined) return null;
  const trimmed = rawAssignee.trim();
  if (!trimmed) return null;
  const exact = (
    await tx.query<{ id: string }>('SELECT id FROM identities WHERE id=$1', [trimmed])
  ).rows[0];
  if (exact) return exact.id;
  const handle = trimmed.replace(/^@+/, '');
  if (!handle) throw new CommandRefusalError(`unknown assignee: ${rawAssignee}`, 400);
  const byHandle = (
    await tx.query<{ id: string }>(
      `SELECT i.id FROM rooms r
       JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL AND w.removed_at IS NULL
       JOIN identities i ON i.id=w.identity_id
       WHERE r.id=$1
         AND lower(COALESCE(NULLIF(beeline_workspace_handle(i.id,r.workspace_id),''),i.handle,''))=lower($2)
       ORDER BY EXISTS(SELECT 1 FROM room_access a WHERE a.room_id=$1 AND a.identity_id=i.id AND a.removed_at IS NULL) DESC, i.id
       LIMIT 1`,
      [roomId, handle],
    )
  ).rows[0];
  if (!byHandle) throw new CommandRefusalError(`unknown assignee: ${rawAssignee}`, 400);
  return byHandle.id;
}

/** Clear open assignment Needs you marks for a work item. */
export async function clearWorkAssignmentMarks(
  tx: SqlDatabase,
  workItemId: string,
  reason: 'answered' | 'superseded' | 'withdrawn',
): Promise<void> {
  await tx.query(
    `UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason=$2
     FROM messages m
     WHERE mark.message_id=m.id AND mark.cleared_at IS NULL
       AND m.card_type='work-assignment' AND m.card->>'workItemId'=$1`,
    [workItemId, reason],
  );
}

/** Write an off-transcript assignment receipt so Needs you and push reach the human assignee. */
async function notifyWorkAssignment(
  tx: SqlDatabase,
  input: {
    roomId: string;
    workItemId: string;
    actorId: string;
    assigneeId: string;
    title: string;
    objective: string;
  },
): Promise<void> {
  if (input.assigneeId === input.actorId) return;
  const target = (
    await tx.query<{ kind: string; chat_name: string }>(
      `SELECT i.kind,COALESCE(parent.name,r.name) chat_name
       FROM identities i
       JOIN rooms r ON r.id=$2
       LEFT JOIN rooms parent ON parent.id=r.parent_id
       JOIN room_access a ON a.room_id=r.id AND a.identity_id=i.id AND a.removed_at IS NULL
       WHERE i.id=$1`,
      [input.assigneeId, input.roomId],
    )
  ).rows[0];
  if (!target || target.kind !== 'human') return;
  const actor = (
    await tx.query<{ name: string | null; handle: string | null }>(
      `SELECT name,handle FROM identities WHERE id=$1`,
      [input.actorId],
    )
  ).rows[0];
  const actorName = actor?.name?.trim() || actor?.handle?.trim() || 'Someone';
  const taskName = cornerShortTitle(target.chat_name, input.title, input.workItemId);
  const text = `${actorName} assigned you backlog item ${taskName}`;
  const card = {
    workItemId: input.workItemId,
    assigneeId: input.assigneeId,
    title: taskName,
    ...(input.objective ? { objective: input.objective } : {}),
  };
  await tx.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
     VALUES($1,$2,$3,$4,'card','work-assignment',$5::jsonb)`,
    [randomBytes(32).toString('hex'), input.roomId, input.actorId, text, JSON.stringify(card)],
  );
}

/** Synthesize brief revision 1 from a backlog task's title, objective, notes, and attachments. */
async function synthesizeWorkItemBrief(
  tx: SqlDatabase,
  input: {
    cornerId: string;
    parentRoomId: string;
    title: string;
    objective: string;
    actorId: string;
    actorKind: 'human' | 'agent';
    actorName: string;
  },
): Promise<{ spec: string; attachments: CornerBriefAttachment[] }> {
  const [notes, rawAttachments] = await Promise.all([
    tx.query<{ text: string; author_name: string }>(
      `SELECT e.text,i.name author_name
       FROM work_item_entries e JOIN identities i ON i.id=e.author_id
       WHERE e.work_item_id=$1 AND e.kind='note'
       ORDER BY e.created_at,e.id`,
      [input.cornerId],
    ),
    tx.query<{
      kind: 'file' | 'link';
      name: string;
      url: string | null;
      object_id: string | null;
      title: string | null;
      mime: string | null;
      sha256: string | null;
      size: string | null;
    }>(
      `SELECT a.kind,a.name,a.url,a.object_id::text object_id,o.title,o.mime,o.sha256,o.size::text
       FROM work_item_attachments a
       LEFT JOIN objects o ON o.id=a.object_id AND o.state='ready'
       WHERE a.work_item_id=$1
       ORDER BY a.created_at,a.id`,
      [input.cornerId],
    ),
  ]);
  const intentQuote = input.objective.trim() || input.title;
  const sections: string[] = [
    `## Intent\n\n> ${intentQuote}\n>\n> — Promoted from backlog task \`${input.title}\` by ${input.actorName}`,
  ];
  if (notes.rows.length) {
    sections.push(
      `## Notes\n\n${notes.rows.map((n) => `- ${n.author_name}: ${n.text}`).join('\n')}`,
    );
  }
  const attachments: CornerBriefAttachment[] = [];
  const refLines: string[] = [];
  for (const att of rawAttachments.rows) {
    if (att.kind === 'link' && att.url) {
      refLines.push(`- [${att.name}](${att.url})`);
    } else if (att.kind === 'file' && att.object_id && att.mime && att.sha256 && att.size != null) {
      if (attachments.length < 16) {
        attachments.push({
          objectId: att.object_id.toLowerCase(),
          title: att.title || att.name,
          purpose: `Attached to backlog task ${input.title}`,
          required: false,
          mime: att.mime,
          sha256: att.sha256,
          size: Number(att.size),
        });
      }
      refLines.push(`- ${att.name} (file \`${att.object_id}\`)`);
    }
  }
  if (refLines.length) sections.push(`## References\n\n${refLines.join('\n')}`);
  const spec = sections.join('\n\n');
  const revisionHash = cornerBriefRevisionHash({ spec }, attachments);
  const approvalBasis = {
    kind: input.actorKind === 'human' ? 'commander-direct' : 'agent-initiated',
    sourceMessageId: '',
    snapshot: intentQuote,
    approvedBy: input.actorId,
    briefHash: revisionHash,
    approvedAt: new Date().toISOString(),
  };
  await tx.query(
    `INSERT INTO corner_brief_revisions(
       corner_id,revision,spec,approval_basis,revision_hash,change,author_id,
       source_room_id,source_message_id,attachments,objective
     ) VALUES($1,1,$2,$3,$4,NULL,$5,$6,NULL,$7,$8)
     ON CONFLICT(corner_id,revision) DO NOTHING`,
    [
      input.cornerId,
      spec,
      JSON.stringify(approvalBasis),
      revisionHash,
      input.actorId,
      input.parentRoomId,
      JSON.stringify(attachments),
      input.objective,
    ],
  );
  return { spec, attachments };
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

  let wasBacklog = false;
  let parkedThread = false;
  let unparkedThread = false;
  let threadParentId: string | null = null;
  let threadName = '';
  let threadObjective = '';
  let threadHasRepo = false;

  await db.transaction(async (tx) => {
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
         JOIN room_access member ON member.room_id=r.id AND member.identity_id=$2 AND member.removed_at IS NULL
         WHERE r.id=$1`,
        [input.roomId, accessIdentityId],
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

    if (thread) {
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
    FROM rooms r JOIN room_access member ON member.room_id=r.id AND member.identity_id=$9 AND member.removed_at IS NULL
    LEFT JOIN corner_facts f ON f.corner_id=r.id WHERE r.id=$1
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
      ],
    );
    const item = changed.rows[0];
    if (!item) throw new CommandRefusalError('room access denied', 403);
    threadObjective = item.objective ?? '';

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
      const cornerName = normalizeWorkTitle(item.title ?? undefined) ?? 'untitled-task';
      const actor = (
        await tx.query<{ name: string | null; kind: 'human' | 'agent' }>(
          'SELECT name,kind FROM identities WHERE id=$1',
          [actorId],
        )
      ).rows[0];
      const actorName = actor?.name?.trim() || 'Someone';
      const actorKind = actor?.kind ?? 'human';

      await tx.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,repository_key,repository_target_branch)
         VALUES($1::uuid,$2,$3,$4,$5,$6,$7)`,
        [
          itemId,
          room.workspace_id,
          room.id,
          actorId,
          cornerName,
          room.repository_key,
          room.repository_target_branch ?? 'main',
        ],
      );
      await createCornerFacts(tx, itemId);
      await tx.query(
        `UPDATE work_items SET room_id=$1::uuid,state=NULL,completed_at=NULL,title=$2,updated_at=now() WHERE id=$1::text`,
        [itemId, cornerName],
      );
      if (item.objective) await writeCornerObjective(tx, itemId, item.objective, true);
      await clearWorkAssignmentMarks(tx, itemId, 'answered');

      const hasOpenCard =
        ((
          await tx.query(
            `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='daemon-fact'
               AND card->>'type'='corner-open' AND card->>'cornerId'=$2 LIMIT 1`,
            [room.id, itemId],
          )
        ).rowCount ?? 0) > 0;
      if (!hasOpenCard) {
        await systemLine(tx, {
          roomId: room.id,
          subject: { kind: actorKind === 'agent' ? 'agent' : 'person', id: actorId, name: actorName },
          verb: systemMessage('daemon-service.opened-a-corner'),
          kind: 'corner-opened',
          object: { text: cornerName, id: itemId },
          presentation: 'card',
          cardType: 'daemon-fact',
          card: {
            type: 'corner-open',
            cornerId: itemId,
            name: cornerName,
            objective: item.objective || cornerName,
          },
        });
      }

      const agentAssignee = item.assignee_id
        ? (
            await tx.query<{ id: string }>(
              `SELECT i.id FROM identities i
               JOIN room_access a ON a.room_id=$2 AND a.identity_id=i.id AND a.removed_at IS NULL
               WHERE i.id=$1 AND i.kind='agent'`,
              [item.assignee_id, room.id],
            )
          ).rows[0]?.id
        : undefined;
      if (agentAssignee) {
        await becomeThreadImplementer(tx, itemId, agentAssignee);
        const { spec } = await synthesizeWorkItemBrief(tx, {
          cornerId: itemId,
          parentRoomId: room.id,
          title: cornerName,
          objective: item.objective ?? '',
          actorId,
          actorKind,
          actorName,
        });
        await advanceCorner(tx, itemId, {
          kind: 'open',
          command: {
            roomId: itemId,
            agentId: agentAssignee,
            sourceMessageId: null,
            privatePayload: {
              objective: item.objective || cornerName,
              text: modelText(spec),
              authorId: actorId,
              fromRoomId: room.id,
              kind: 'message',
              route: {
                from: { agent: actorId, place: room.id },
                to: { agent: agentAssignee, place: itemId },
              },
              openKey: `work-promote:${itemId}`,
            },
            reason: 'corner_objective',
          },
        });
      }
    } else if (!isAskMessage) {
      if (input.state === 'done' || input.state === 'in-progress') {
        await clearWorkAssignmentMarks(tx, itemId, 'answered');
      }
      if (thread && input.state === 'backlog') {
        parkedThread = true;
        await lockCornerLifecycle(tx, input.roomId);
        await cancelCornerAgentCommands(tx, input.roomId);
        await tx.query(
          `UPDATE agent_turns SET status='cancelled',created_at=clock_timestamp()
           WHERE room_id=$1 AND status='working'`,
          [input.roomId],
        );
        await tx.query(
          `DELETE FROM live_outputs WHERE room_id=$1 AND kind IN ('draft','thought')`,
          [input.roomId],
        );
        await abandonCornerWorkflowRuns(tx, input.roomId);
        await tx.query(
          `UPDATE messages m
           SET ask_closed_reason=COALESCE(m.ask_closed_reason,'withdrawn'),
               ask_closed_by=COALESCE(m.ask_closed_by,$2)
           WHERE m.ask_closed_reason IS NULL
             AND (m.block_corner_id=$1::uuid
               OR (m.room_id=$1::uuid AND (
                 m.card->>'reportStatus' IN ('blocked','needs-decision')
                 OR m.card->'ask' IS NOT NULL
                 OR EXISTS(SELECT 1 FROM work_questions q WHERE q.message_id=m.id)
               ))
               OR (m.card->>'sourceRoomId'=$1::text AND m.card->>'reportStatus' IN ('blocked','needs-decision')))`,
          [input.roomId, actorId],
        );
        await tx.query(
          `UPDATE room_choices c SET status='closed'
           FROM messages m
           WHERE c.message_id=m.id AND c.mode='question' AND c.status='open'
             AND (m.room_id=$1::uuid OR m.block_corner_id=$1::uuid OR m.card->'route'->'from'->>'place'=$1::text)`,
          [input.roomId],
        );
        await tx.query(
          `UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='withdrawn'
           FROM messages m
           WHERE mark.workspace_id=$2 AND mark.cleared_at IS NULL AND m.id=mark.message_id
             AND (m.room_id=$1::uuid OR ${humanReportCornerSql('m')}=$1::text)`,
          [input.roomId, room.workspace_id],
        );
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

  if (thread && input.state === 'done') {
    await hooks.closeThread!();
  } else if (parkedThread) {
    await advanceCorner(db, input.roomId, { kind: 'backlog', backlog: true });
    await hooks.reconcileMergeQueue?.(input.roomId);
  } else if (unparkedThread) {
    await advanceCorner(db, input.roomId, { kind: 'backlog', backlog: false });
    if (wasBacklog && input.state === 'in-progress' && threadParentId) {
      const implementer = (
        await db.query<{ id: string; recorded: boolean }>(
          `SELECT i.id,(f.implementer_agent_id=i.id) recorded
           FROM corner_facts f
           LEFT JOIN work_items w ON w.id=f.corner_id::text
           JOIN identities i ON i.id=COALESCE(f.implementer_agent_id,w.assignee_id) AND i.kind='agent'
           JOIN room_access a ON a.room_id=$2 AND a.identity_id=i.id AND a.removed_at IS NULL
           WHERE f.corner_id=$1`,
          [input.roomId, threadParentId],
        )
      ).rows[0];
      if (implementer) {
        if (!implementer.recorded) await becomeThreadImplementer(db, input.roomId, implementer.id);
        if (threadHasRepo) {
          const hasBrief =
            ((
              await db.query('SELECT 1 FROM corner_brief_revisions WHERE corner_id=$1 LIMIT 1', [
                input.roomId,
              ])
            ).rowCount ?? 0) > 0;
          if (!hasBrief) {
            const actor = (
              await db.query<{ name: string | null; kind: 'human' | 'agent' }>(
                'SELECT name,kind FROM identities WHERE id=$1',
                [actorId],
              )
            ).rows[0];
            await synthesizeWorkItemBrief(db, {
              cornerId: input.roomId,
              parentRoomId: threadParentId,
              title: threadName,
              objective: threadObjective,
              actorId,
              actorKind: actor?.kind ?? 'human',
              actorName: actor?.name?.trim() || 'Someone',
            });
          }
        }
        const active =
          ((
            await db.query(
              `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'
               UNION ALL
               SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'
               LIMIT 1`,
              [input.roomId, implementer.id],
            )
          ).rowCount ?? 0) > 0;
        if (!active) {
          await createAgentCommand(db, {
            roomId: input.roomId,
            agentId: implementer.id,
            sourceMessageId: null,
            privatePayload: {
              kind: 'message',
              authorId: actorId,
              fromRoomId: threadParentId,
              text: modelText(`Moved back to In progress from Backlog. Resume work on ${threadName}.`),
              route: {
                from: { agent: actorId, place: threadParentId },
                to: { agent: implementer.id, place: input.roomId },
              },
            },
            reason: 'corner_objective',
          });
          await advanceCorner(db, input.roomId, { kind: 'reconcile' });
        }
      }
    }
  }
}
