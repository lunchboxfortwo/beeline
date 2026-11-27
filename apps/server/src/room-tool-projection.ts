import type { RoomToolPage, RoomToolReference, RoomViewMessage } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { PhoneOperationError } from './phone-operations.js';
import { sanitizeActivityList } from './sanitize-activity.js';

type Summary = {
  id: string;
  author_id: string;
  name: string;
  kind: 'agent' | 'human';
  created_at: Date;
  request_id: string | null;
  count: number;
};

const authorized = `SELECT room.id,room.workspace_id FROM rooms room
  JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id) AND member.identity_id=$2 AND member.removed_at IS NULL
  JOIN memberships workspace ON workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
    AND workspace.identity_id=$2 AND workspace.removed_at IS NULL WHERE room.id=$1`;

const isTool = `message.presentation='activity' AND message.deleted_at IS NULL AND message.durable_fact IS NULL
  AND jsonb_typeof(message.activity)='array'
  AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(message.activity) item
    WHERE jsonb_typeof(item)='object' AND item->>'kind'='tool'
  )`;

/**
 * Cheap bounded presence expression in SQL (no list-time diff parsing, every
 * JSONB shape guarded with `jsonb_typeof` before array expansion or casts).
 * True when the stored item holds server-side detail withheld from the list row.
 */
const hasStoredDetailSql = `COALESCE((
  COALESCE(item->'outputHidden' = 'true'::jsonb, false)
  OR (
    jsonb_typeof(item->'output')='string'
    AND length(btrim(item->>'output'))>0
    AND NOT COALESCE(item->'terminalOnly' = 'true'::jsonb, false)
    AND NOT (
      btrim(item->>'output') ~ '^\\[\\s*\\{\\s*"type"\\s*:\\s*"terminal"'
      AND (item->>'output') !~ '"(?:text|output|content)"'
      AND (jsonb_typeof(item->'command')<>'string' OR length(btrim(item->>'command'))=0)
    )
  )
  OR (jsonb_typeof(item->'blocks')='array' AND jsonb_array_length(item->'blocks')>0)
  OR (
    jsonb_typeof(item->'files')='array'
    AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(item->'files') f
      WHERE jsonb_typeof(f)='object' AND jsonb_typeof(f->'diff')='string' AND length(btrim(f->>'diff'))>0
    )
  )
  OR (
    jsonb_typeof(item->'plan')='object'
    AND jsonb_typeof(item->'plan'->'items')='array'
    AND jsonb_array_length(item->'plan'->'items')>0
  )
  OR jsonb_typeof(item->'requestedBy')='object'
), false)`;

const listActivitySql = `(
  SELECT jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'kind','tool',
      'title',CASE WHEN jsonb_typeof(item->'title')='string' THEN left(item->>'title',240) ELSE 'Tool' END,
      'operation',CASE WHEN jsonb_typeof(item->'operation')='string' THEN left(item->>'operation',64) ELSE NULL END,
      'status',CASE WHEN jsonb_typeof(item->'status')='string' THEN left(item->>'status',32) ELSE NULL END,
      'summary',CASE WHEN jsonb_typeof(item->'summary')='string' THEN left(item->>'summary',200) ELSE NULL END,
      'exitCode',CASE WHEN jsonb_typeof(item->'exitCode')='number' AND (item->>'exitCode') ~ '^-?[0-9]+$' THEN (item->>'exitCode')::integer ELSE NULL END,
      'signal',CASE WHEN jsonb_typeof(item->'signal')='string' AND length(btrim(item->>'signal'))>0 THEN left(item->>'signal',32) ELSE NULL END,
      'outputTruncated',CASE WHEN item->'outputTruncated'='true'::jsonb THEN true ELSE NULL END,
      'omittedCount',CASE WHEN jsonb_typeof(item->'omittedCount')='number' AND (item->>'omittedCount') ~ '^[1-9][0-9]*$' THEN (item->>'omittedCount')::integer ELSE NULL END,
      'terminalOnly',CASE WHEN item->'terminalOnly'='true'::jsonb THEN true ELSE NULL END,
      'outputHidden',CASE WHEN item->'outputHidden'='true'::jsonb THEN true ELSE NULL END,
      'sanitized',CASE WHEN item->'sanitized'='true'::jsonb THEN true ELSE NULL END,
      'origin',CASE WHEN jsonb_typeof(item->'origin')='object' AND item->'origin'->>'kind'='subagent' THEN jsonb_strip_nulls(jsonb_build_object(
        'kind','subagent',
        'label',CASE WHEN jsonb_typeof(item->'origin'->'label')='string' THEN left(item->'origin'->>'label',80) ELSE NULL END,
        'sessionId',CASE WHEN jsonb_typeof(item->'origin'->'sessionId')='string' THEN left(item->'origin'->>'sessionId',128) ELSE NULL END
      )) ELSE NULL END,
      'command',CASE WHEN jsonb_typeof(item->'command')='string' THEN left(item->>'command',500) ELSE NULL END,
      'input',CASE WHEN jsonb_typeof(item->'input')='string' THEN left(item->>'input',500) ELSE NULL END,
      'files',CASE WHEN jsonb_typeof(item->'files')='array' THEN (
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'path',left(file->>'path',260),
          'status',CASE WHEN jsonb_typeof(file->'status')='string' THEN left(file->>'status',32) ELSE NULL END,
          'diffTruncated',CASE WHEN file->'diffTruncated'='true'::jsonb THEN true ELSE NULL END,
          'addedLines',CASE WHEN jsonb_typeof(file->'addedLines')='number' AND (file->>'addedLines') ~ '^[0-9]+$' THEN (file->>'addedLines')::integer ELSE NULL END,
          'removedLines',CASE WHEN jsonb_typeof(file->'removedLines')='number' AND (file->>'removedLines') ~ '^[0-9]+$' THEN (file->>'removedLines')::integer ELSE NULL END,
          'line',CASE WHEN jsonb_typeof(file->'line')='number' AND (file->>'line') ~ '^[1-9][0-9]*$' THEN (file->>'line')::integer ELSE NULL END,
          'endLine',CASE WHEN jsonb_typeof(file->'endLine')='number' AND (file->>'endLine') ~ '^[1-9][0-9]*$' THEN (file->>'endLine')::integer ELSE NULL END
        )) ORDER BY file_ord)
        FROM (
          SELECT value AS file, ordinality AS file_ord
          FROM jsonb_array_elements(item->'files') WITH ORDINALITY
          LIMIT 8
        ) bounded_files
        WHERE jsonb_typeof(file)='object' AND jsonb_typeof(file->'path')='string'
      ) ELSE NULL END,
      'hasDetail',has_detail,
      'toolOutput',CASE WHEN has_detail THEN jsonb_build_object(
        'roomId',$1::text,
        'anchor',$2::text,
        'messageId',message.id,
        'itemIndex',item_index,
        'hasDetail',true
      ) ELSE NULL END
    ))
    ORDER BY ord
  )
  FROM (
    SELECT
      elem.item,
      elem.ord,
      (row_number() OVER (ORDER BY elem.ord) - 1)::integer AS item_index,
      ${hasStoredDetailSql} AS has_detail
    FROM jsonb_array_elements(message.activity) WITH ORDINALITY AS elem(item, ord)
    WHERE jsonb_typeof(elem.item)='object' AND elem.item->>'kind'='tool'
  ) projected
)`;

const fullActivitySql = `(
  SELECT jsonb_agg(elem.item ORDER BY elem.ord)
  FROM jsonb_array_elements(message.activity) WITH ORDINALITY AS elem(item, ord)
  WHERE jsonb_typeof(elem.item)='object' AND elem.item->>'kind'='tool'
)`;

/** Existing disclosure/Open actions own each bounded page. The optional
 * message target loads one full stored tool result, never a Room refetch. */
export async function readRoomTools(
  database: SqlDatabase,
  input: RoomToolReference & { before?: string; messageId?: string },
  reader: string,
): Promise<RoomToolPage> {
  return database.transaction(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const room = (await db.query<{ workspace_id: string }>(authorized, [input.roomId, reader])).rows[0];
    if (!room) throw new PhoneOperationError(403, { error: 'access_denied' });
    const full = input.messageId !== undefined;
    const rows = (
      await db.query<Summary & { activity: RoomViewMessage['activity']; more: boolean }>(
        `WITH anchor AS (
      SELECT id,created_at,author_id,request_id,turn_id FROM messages WHERE id=$2 AND room_id=$1 AND presentation='activity' AND deleted_at IS NULL
    ), cursor AS (SELECT created_at,id FROM messages WHERE id=$3 AND room_id=$1), page AS (
      SELECT message.id,message.author_id,message.created_at,message.request_id,
        ${full ? fullActivitySql : listActivitySql} activity
      FROM messages message JOIN anchor ON message.author_id=anchor.author_id
        AND message.request_id IS NOT DISTINCT FROM anchor.request_id AND message.turn_id IS NOT DISTINCT FROM anchor.turn_id
      WHERE message.room_id=$1 AND ${isTool}
        AND (message.created_at,message.id)<=(anchor.created_at,anchor.id)
        AND ($3::text IS NULL OR (message.created_at,message.id)<(SELECT created_at,id FROM cursor))
        AND ($4::text IS NULL OR message.id=$4)
      ORDER BY message.created_at DESC,message.id DESC LIMIT ${full ? 1 : 51}
    ) SELECT page.*,left(person.name,128) name,person.kind FROM page JOIN identities person ON person.id=page.author_id
      ORDER BY page.created_at DESC,page.id DESC`,
        [input.roomId, input.anchor, input.before ?? null, input.messageId ?? null],
      )
    ).rows;
    const page = rows.slice(0, 50);
    const result: RoomToolPage = {
      roomId: input.roomId,
      messages: page.map((row) => ({
        id: row.id,
        text: '',
        createdAt: Math.floor(row.created_at.getTime() / 1000),
        createdAtMs: row.created_at.getTime(),
        author: { pubkey: row.author_id, kind: row.kind, name: row.name },
        presentation: 'activity',
        activity: sanitizeActivityList(row.activity, { full }) ?? [],
        ...(row.request_id ? { requestId: row.request_id } : {}),
      })),
      ...(rows.length > 50 ? { next: page.at(-1)!.id } : {}),
    };
    return result;
  });
}
