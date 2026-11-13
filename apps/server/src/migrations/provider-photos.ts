import { githubProviderKey } from '../providers/index.js';
import type { SqlDatabase } from '../database.js';

/** Repair missing photos from verified provider links without replacing a person's picture. */
export async function backfillProviderPhotos(database: SqlDatabase): Promise<number> {
  const github = await database.query(`WITH photos AS (
      SELECT DISTINCT ON (identity_id) identity_id,subject FROM identity_external_links
      WHERE provider='${githubProviderKey}' AND subject ~ '^[0-9]+$'
      ORDER BY identity_id,created_at DESC,subject
    ) UPDATE identities person
    SET avatar='https://avatars.githubusercontent.com/u/' || link.subject,updated_at=now()
    FROM photos link
    WHERE link.identity_id=person.id
      AND person.kind='human' AND NULLIF(person.avatar,'') IS NULL
      AND NOT EXISTS (SELECT 1 FROM person_avatars uploaded WHERE uploaded.identity_id=person.id)
    RETURNING person.id`);
  // Auth and server share a database in the monolith; isolated server fixtures
  // and installations without auth have no retained provider tickets.
  const tickets = await database.query<{ present: boolean }>("SELECT to_regclass('beeline_bind_tickets') IS NOT NULL present");
  let googleCount = 0;
  if (tickets.rows[0]?.present) {
    const google = await database.query(`WITH photos AS (
      SELECT DISTINCT ON (link.identity_id) link.identity_id,ticket.provider_avatar
      FROM identity_external_links link JOIN beeline_bind_tickets ticket
        ON ticket.subject=link.subject AND ticket.issuer=link.issuer AND ticket.audience=link.audience
      WHERE link.provider='google' AND ticket.consumed_at IS NOT NULL
        AND ticket.provider_avatar ~ '^https://[^/]+[.]googleusercontent[.]com/'
      ORDER BY link.identity_id,ticket.created_at DESC
    ) UPDATE identities person SET avatar=photos.provider_avatar,updated_at=now()
      FROM photos WHERE person.id=photos.identity_id AND person.kind='human' AND NULLIF(person.avatar,'') IS NULL
        AND NOT EXISTS (SELECT 1 FROM person_avatars uploaded WHERE uploaded.identity_id=person.id)
      RETURNING person.id`);
    googleCount = google.rowCount;
  }
  const count = github.rowCount + googleCount;
  console.info('Provider photo backfill: %d people updated', count);
  return count;
}
