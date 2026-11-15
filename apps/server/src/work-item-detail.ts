import type {
  AddWorkNoteInput,
  AttachToWorkItemInput,
  WorkItemView,
  WorkItemAddress,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { phoneIdentity, type PhoneIdentityRow } from './phone-identity.js';
import { CommandRefusalError } from './command-refusal.js';
import { authorizedMediaMetadata } from './phone-media.js';
import { updateWorkItem, workBoardScope } from './work-board.js';

type EntryRow = {
  id: string;
  author: PhoneIdentityRow;
  kind: 'note' | 'event';
  text: string;
  created_at: string;
};
type AttachmentRow = {
  id: string;
  added_by: PhoneIdentityRow;
  kind: 'file' | 'link';
  name: string;
  url: string;
  object_id: string;
  mime: string;
  size: string;
  sha256: string;
  expired: boolean;
  created_at: string;
};
export type WorkDetailRow = { entries: EntryRow[]; attachments: AttachmentRow[] };

/** Indexed tails keep the board read bounded per item; newest is painted last. */
export function workDetailColumnsSql(itemId: string): string {
  return `COALESCE((SELECT jsonb_agg(tail ORDER BY tail.created_at,tail.id) FROM (
    SELECT e.id,e.kind,e.text,e.created_at,row_to_json(author) author
    FROM work_item_entries e JOIN identities author ON author.id=e.author_id
    WHERE e.work_item_id=${itemId} ORDER BY e.created_at DESC,e.id DESC LIMIT 100
  ) tail),'[]'::jsonb) entries,
  COALESCE((SELECT jsonb_agg(tail ORDER BY tail.created_at,tail.id) FROM (
    SELECT a.id,a.kind,a.name,a.url,a.object_id,a.created_at,row_to_json(author) added_by,
      o.mime,o.size::text,o.sha256,(o.state<>'ready' OR o.expires_at<=now()
        OR EXISTS(SELECT 1 FROM object_expirations expired WHERE expired.id=o.id)) expired
    FROM work_item_attachments a JOIN identities author ON author.id=a.added_by
    LEFT JOIN objects o ON o.id=a.object_id
    WHERE a.work_item_id=${itemId} ORDER BY a.created_at DESC,a.id DESC LIMIT 100
  ) tail),'[]'::jsonb) attachments`;
}
export function projectWorkDetail(
  row: WorkDetailRow,
  origin: string,
): Pick<WorkItemView, 'entries' | 'attachments'> {
  return {
    entries: row.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      text: e.text,
      author: phoneIdentity(e.author, origin),
      createdAt: new Date(e.created_at).getTime() / 1000,
    })),
    attachments: row.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      addedBy: phoneIdentity(a.added_by, origin),
      createdAt: new Date(a.created_at).getTime() / 1000,
      ...(a.kind === 'link'
        ? { kind: 'link' as const, url: a.url }
        : {
            kind: 'file' as const,
            file: {
              url: `${origin}/v1/media/${a.object_id}`,
              name: a.name,
              mimeType: a.mime,
              size: Number(a.size),
              sha256: a.sha256,
              ...(a.expired ? { expired: true } : {}),
            },
          }),
    })),
  };
}

async function detailItem(db: SqlDatabase, input: WorkItemAddress, actor: string): Promise<string> {
  if (!(await workBoardScope(db, input.roomId, actor)))
    throw new CommandRefusalError('room access denied', 403);
  const id = input.id ?? input.roomId;
  let item = (
    await db.query('SELECT id FROM work_items WHERE id=$1 AND room_id=$2 FOR UPDATE', [
      id,
      input.roomId,
    ])
  ).rows[0];
  // Threads and asking messages can be projected before stored task metadata exists.
  if (!item) {
    const source = (
      await db.query(
        `SELECT r.id FROM rooms r WHERE r.id=$1 AND (
      ($2=r.id::text AND r.parent_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM messages m WHERE m.id=$2 AND m.room_id=r.id))`,
        [input.roomId, id],
      )
    ).rows[0];
    if (source) {
      await updateWorkItem(
        db,
        { ...input, ...(id !== input.roomId ? { state: 'needs-you' as const } : {}) },
        actor,
      );
      item = { id };
    }
  }
  if (!item) throw new CommandRefusalError('room access denied', 403);
  return id;
}
export async function addWorkNote(
  db: SqlDatabase,
  input: AddWorkNoteInput,
  actor: string,
): Promise<void> {
  if (!input.text.trim()) return;
  await db.transaction(async (tx) => {
    const id = await detailItem(tx, input, actor);
    await tx.query(
      `INSERT INTO work_item_entries(work_item_id,author_id,kind,text) VALUES($1,$2,'note',$3)`,
      [id, actor, input.text.trim()],
    );
  });
}
export async function attachToWorkItem(
  db: SqlDatabase,
  input: AttachToWorkItemInput,
  actor: string,
): Promise<void> {
  const attachment = input.attachment;
  if (attachment.kind === 'link') {
    const url = new URL(attachment.url);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new CommandRefusalError('invalid attachment', 400);
  }
  await db.transaction(async (tx) => {
    const id = await detailItem(tx, input, actor);
    if (attachment.kind === 'file') await authorizedMediaMetadata(tx, attachment.objectId, actor);
    await tx.query(
      `INSERT INTO work_item_attachments(work_item_id,kind,name,url,object_id,added_by)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        attachment.kind,
        attachment.name,
        attachment.kind === 'link' ? attachment.url : null,
        attachment.kind === 'file' ? attachment.objectId : null,
        actor,
      ],
    );
  });
}
