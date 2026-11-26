import { createHash, randomBytes } from 'node:crypto';
import { fixCornerText, type CornerBriefAttachment } from '@beeline/api-contract/daemon';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { cornerShortTitle, type UpdateWorkItemInput } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { writeCornerObjective } from './corner-objective.js';
import { CommandRefusalError } from './command-refusal.js';
import {
  advanceCorner,
  becomeThreadImplementer,
  cancelCornerAgentCommands,
  createCornerFacts,
  lockCornerLifecycle,
} from './corner-lifecycle.js';
import type { AgentCommandInput } from './agent-command.js';
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
export async function resolveWorkAssigneeId(
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
export async function notifyWorkAssignment(
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
  const card = {
    workItemId: input.workItemId,
    assigneeId: input.assigneeId,
    title: taskName,
    ...(input.objective ? { objective: input.objective } : {}),
  };
  await systemLine(tx, {
    roomId: input.roomId,
    authorId: input.actorId,
    subject: { kind: 'person', name: actorName },
    verb: 'assigned you backlog item',
    object: taskName,
    presentation: 'card',
    cardType: 'work-assignment',
    card,
    routeCommands: false,
  });
}

/** Synthesize brief revision 1 from a backlog task's title, objective, notes, and attachments. */
export async function synthesizeWorkItemBrief(
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

/** Promote an unopened standalone UUID backlog task in-place into its thread. */
export async function promoteUnopenedTaskToThread(
  tx: SqlDatabase,
  input: {
    itemId: string;
    room: {
      id: string;
      workspace_id: string;
      repository_key: string | null;
      repository_target_branch: string | null;
    };
    title: string | null;
    objective: string | null;
    assigneeId: string | null;
    actorId: string;
  },
): Promise<void> {
  const cornerName = normalizeWorkTitle(input.title ?? undefined) ?? 'untitled-task';
  const actor = (
    await tx.query<{ name: string | null; kind: 'human' | 'agent' }>(
      'SELECT name,kind FROM identities WHERE id=$1',
      [input.actorId],
    )
  ).rows[0];
  const actorName = actor?.name?.trim() || 'Someone';
  const actorKind = actor?.kind ?? 'human';

  await tx.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,repository_key,repository_target_branch)
     VALUES($1::uuid,$2,$3,$4,$5,$6,$7)`,
    [
      input.itemId,
      input.room.workspace_id,
      input.room.id,
      input.actorId,
      cornerName,
      input.room.repository_key,
      input.room.repository_target_branch ?? 'main',
    ],
  );
  await createCornerFacts(tx, input.itemId);
  // Updating completed_at after inserting the thread fires thread_work_state, which clears stored state.
  await tx.query(
    `UPDATE work_items SET room_id=$1::uuid,completed_at=NULL,title=$2,updated_at=now() WHERE id=$1::text`,
    [input.itemId, cornerName],
  );
  if (input.objective) await writeCornerObjective(tx, input.itemId, input.objective, true);
  await clearWorkAssignmentMarks(tx, input.itemId, 'answered');

  const hasOpenCard =
    ((
      await tx.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='daemon-fact'
           AND system_event->>'kind'='corner-opened' AND card->>'cornerId'=$2 LIMIT 1`,
        [input.room.id, input.itemId],
      )
    ).rowCount ?? 0) > 0;
  if (!hasOpenCard) {
    await systemLine(tx, {
      roomId: input.room.id,
      subject: { kind: actorKind === 'agent' ? 'agent' : 'person', id: input.actorId, name: actorName },
      verb: systemMessage('daemon-service.opened-a-corner'),
      kind: 'corner-opened',
      object: { text: cornerName, id: input.itemId },
      presentation: 'card',
      cardType: 'daemon-fact',
      card: {
        type: 'corner-open',
        cornerId: input.itemId,
        name: cornerName,
        objective: input.objective || cornerName,
      },
    });
  }

  const agentAssignee = input.assigneeId
    ? (
        await tx.query<{ id: string }>(
          `SELECT i.id FROM identities i
           JOIN room_access a ON a.room_id=$2 AND a.identity_id=i.id AND a.removed_at IS NULL
           WHERE i.id=$1 AND i.kind='agent'`,
          [input.assigneeId, input.room.id],
        )
      ).rows[0]?.id
    : undefined;
  if (agentAssignee) {
    await becomeThreadImplementer(tx, input.itemId, agentAssignee);
    const { spec } = await synthesizeWorkItemBrief(tx, {
      cornerId: input.itemId,
      parentRoomId: input.room.id,
      title: cornerName,
      objective: input.objective ?? '',
      actorId: input.actorId,
      actorKind,
      actorName,
    });
    await advanceCorner(tx, input.itemId, {
      kind: 'open',
      command: {
        roomId: input.itemId,
        agentId: agentAssignee,
        sourceMessageId: null,
        privatePayload: {
          objective: input.objective || cornerName,
          text: modelText(spec),
          authorId: input.actorId,
          fromRoomId: input.room.id,
          kind: 'message',
          route: {
            from: { agent: input.actorId, place: input.room.id },
            to: { agent: agentAssignee, place: input.itemId },
          },
          openKey: `work-promote:${input.itemId}`,
        },
        reason: 'corner_objective',
      },
    });
  }
}

/** Promote an existing standalone backlog task row in-place into its opened thread row. */
export async function promoteBacklogTaskRow(
  db: SqlDatabase,
  input: {
    taskId: string;
    cornerId: string;
    effectiveName: string;
    objective: string;
    implementerAgentId: string;
    actorId: string;
  },
  upsertThreadRow: (tx: SqlDatabase, data: UpdateWorkItemInput, actorId: string) => Promise<void>,
): Promise<void> {
  await db.query("SELECT set_config('beeline.work_actor',$1,true)", [input.actorId]);
  if (input.taskId.toLowerCase() === input.cornerId) {
    // Updating completed_at after inserting the thread fires thread_work_state, which clears stored state.
    await db.query(
      `UPDATE work_items SET room_id=$1::uuid,completed_at=NULL,
         title=COALESCE(title,$2),objective=COALESCE(NULLIF($3,''),objective),
         assignee_id=$4,updated_at=now()
       WHERE id=$1::text`,
      [input.cornerId, input.effectiveName, input.objective, input.implementerAgentId],
    );
  } else {
    // Legacy non-UUID backlog row promoted in-place to the new thread UUID.
    const old = (
      await db.query<{
        title: string | null;
        objective: string | null;
        priority: string;
        opened_by: string;
        created_at: Date;
      }>(`SELECT title,objective,priority,opened_by,created_at FROM work_items WHERE id=$1`, [
        input.taskId,
      ])
    ).rows[0];
    await db.query("SELECT set_config('beeline.work_migration','on',true)");
    await upsertThreadRow(
      db,
      {
        roomId: input.cornerId,
        id: input.cornerId,
        title: old?.title ?? input.effectiveName,
        objective: input.objective || old?.objective || undefined,
        assigneeId: input.implementerAgentId,
      },
      input.actorId,
    );
    if (old) {
      await db.query(
        `UPDATE work_items SET priority=$2,opened_by=$3,created_at=$4,updated_at=now() WHERE id=$1`,
        [input.cornerId, old.priority, old.opened_by, old.created_at],
      );
    }
    await db.query(`UPDATE work_item_entries SET work_item_id=$2 WHERE work_item_id=$1`, [
      input.taskId,
      input.cornerId,
    ]);
    await db.query(`UPDATE work_item_attachments SET work_item_id=$2 WHERE work_item_id=$1`, [
      input.taskId,
      input.cornerId,
    ]);
    await db.query(`DELETE FROM work_items WHERE id=$1`, [input.taskId]);
    await db.query("SELECT set_config('beeline.work_migration','',true)");
  }
  await db.query(
    `INSERT INTO work_item_entries(work_item_id,author_id,kind,text) VALUES($1,$2,'event','moved this to In progress')`,
    [input.cornerId, input.actorId],
  );
  await clearWorkAssignmentMarks(db, input.taskId, 'answered');
  if (input.taskId.toLowerCase() !== input.cornerId) {
    await clearWorkAssignmentMarks(db, input.cornerId, 'answered');
  }
}

/** Cancel active commands/turns, abandon workflows, and clear open thread asks when parking in Backlog. */
export async function parkThreadInBacklog(
  tx: SqlDatabase,
  input: { roomId: string; workspaceId: string; actorId: string },
): Promise<void> {
  await lockCornerLifecycle(tx, input.roomId);
  await cancelCornerAgentCommands(tx, input.roomId);
  await tx.query(
    `SELECT (cancelled.ended).* FROM (
       SELECT beeline_project_agent_turn(t.agent_id,t.room_id,t.request_id,'cancelled','backlog',NULL,NULL,true) ended
       FROM agent_turns t WHERE t.room_id=$1 AND t.status='working'
     ) cancelled`,
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
    [input.roomId, input.actorId],
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
    [input.roomId, input.workspaceId],
  );
}

/** Clear Backlog on a parked thread and queue a resume wake when an implementer agent is assigned. */
export async function resumeParkedThread(
  db: SqlDatabase,
  input: {
    roomId: string;
    wasBacklog: boolean;
    state: string | undefined;
    threadParentId: string | null;
    threadName: string;
    threadObjective: string;
    threadHasRepo: boolean;
    actorId: string;
  },
): Promise<void> {
  let resumeCommand: AgentCommandInput | undefined;
  if (input.wasBacklog && input.state === 'in-progress' && input.threadParentId) {
    const implementer = (
      await db.query<{ id: string; recorded: boolean }>(
        `SELECT i.id,(f.implementer_agent_id=i.id) recorded
         FROM corner_facts f
         LEFT JOIN work_items w ON w.id=f.corner_id::text
         JOIN identities i ON i.id=COALESCE(f.implementer_agent_id,w.assignee_id) AND i.kind='agent'
         JOIN room_access a ON a.room_id=$2 AND a.identity_id=i.id AND a.removed_at IS NULL
         WHERE f.corner_id=$1`,
        [input.roomId, input.threadParentId],
      )
    ).rows[0];
    if (implementer) {
      if (!implementer.recorded) await becomeThreadImplementer(db, input.roomId, implementer.id);
      if (input.threadHasRepo) {
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
              [input.actorId],
            )
          ).rows[0];
          await synthesizeWorkItemBrief(db, {
            cornerId: input.roomId,
            parentRoomId: input.threadParentId,
            title: input.threadName,
            objective: input.threadObjective,
            actorId: input.actorId,
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
        resumeCommand = {
          roomId: input.roomId,
          agentId: implementer.id,
          sourceMessageId: null,
          privatePayload: {
            kind: 'message',
            authorId: input.actorId,
            fromRoomId: input.threadParentId,
            text: modelText(`Moved back to In progress from Backlog. Resume work on ${input.threadName}.`),
            route: {
              from: { agent: input.actorId, place: input.threadParentId },
              to: { agent: implementer.id, place: input.roomId },
            },
            openKey: `work-resume:${randomBytes(8).toString('hex')}`,
          },
          reason: 'corner_objective',
        };
      }
    }
  }
  await advanceCorner(db, input.roomId, {
    kind: 'backlog',
    backlog: false,
    ...(resumeCommand ? { command: resumeCommand } : {}),
  });
}
