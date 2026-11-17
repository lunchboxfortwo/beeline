import { artifactByteMetadata, artifactByteMime } from '../artifact-byte-metadata.js';
import type { SqlDatabase } from '../database.js';
import type { ObjectStorage } from '../object-storage.js';
import { workflowBackfillOnce } from './workflow-cleanup.js';

interface Repair { id: string; key: string; mime: string; title: string }

/** Read storage outside SQL transactions; repair durable metadata once at release. */
export async function backfillArtifactByteMetadata(
  database: SqlDatabase, storage: ObjectStorage | undefined,
): Promise<void> {
  await workflowBackfillOnce(database, 'artifact-byte-metadata-v1', async db => {
    const candidates = (await db.query<{ id: string; key: string; title: string | null }>(
      `SELECT id,key,title FROM objects WHERE mime='application/octet-stream' AND state='ready' ORDER BY id`,
    )).rows;
    if (candidates.length && !storage) throw new Error('artifact metadata backfill requires object storage');
    const repairs: Repair[] = [];
    let missing = 0;
    for (const row of candidates) {
      const bytes = await storage!.getObject(row.key);
      if (!bytes) { missing++; continue; }
      if (!artifactByteMime(bytes)) continue;
      const metadata = artifactByteMetadata(bytes, 'application/octet-stream', row.title ?? 'artifact');
      repairs.push({ ...row, mime: metadata.mimeType, title: metadata.title });
    }
    const repaired = await db.transaction(async tx => {
      const changed = (await tx.query<Repair>(
        `UPDATE objects o SET mime=r.mime,title=r.title
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,key text,mime text,title text)
         WHERE o.id=r.id AND o.key=r.key AND o.mime='application/octet-stream' AND o.state='ready'
         RETURNING o.id,o.key,o.mime,o.title`, [JSON.stringify(repairs)],
      )).rows;
      if (!changed.length) return { objects: 0, messages: 0, pending: 0 };
      const data = JSON.stringify(changed);
      // Correlate the rewrite to the UPDATE target, so concurrent appends are
      // preserved by PostgreSQL's row recheck. Keep attachment order and fields.
      const messages = await tx.query(
        `WITH repairs AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text,mime text,title text))
         UPDATE messages m SET attachments=(
           SELECT jsonb_agg(CASE WHEN r.id IS NOT NULL AND a.value->>'mimeType'='application/octet-stream'
             THEN a.value || jsonb_build_object('mimeType',r.mime) ELSE a.value END ORDER BY a.ordinality)
           FROM jsonb_array_elements(m.attachments) WITH ORDINALITY a(value,ordinality)
           LEFT JOIN repairs r ON a.value->>'url' ~ ('/v1/media/' || r.id || '$'))
         WHERE m.attachments @> '[{"mimeType":"application/octet-stream"}]'::jsonb
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.attachments) a
             JOIN repairs r ON a->>'url' ~ ('/v1/media/' || r.id || '$')
             WHERE a->>'mimeType'='application/octet-stream')`, [data],
      );
      const pending = await tx.query(
        `UPDATE agent_pending_attachments p SET mime_type=r.mime
         FROM jsonb_to_recordset($1::jsonb) AS r(id text,mime text,title text)
         WHERE p.mime_type='application/octet-stream' AND p.url ~ ('/v1/media/' || r.id || '$')`, [data],
      );
      return { objects: changed.length, messages: messages.rowCount, pending: pending.rowCount };
    });
    console.log(`[migration] artifact byte metadata: ${JSON.stringify({ scanned: candidates.length, ...repaired, missing })}`);
  });
}
