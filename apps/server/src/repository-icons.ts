import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { isRepositoryIconPath, resolveHomepageIcon, resolveRepositoryIcon } from './company-logos.js';

export type IconRepository = { repository_id: string; installation_id: string; full_name: string; default_branch: string; homepage: string | null };
/** One GET under the repository with its installation's token. */
export type IconRepositoryRead = (repository: IconRepository, path: string) => Promise<unknown>;

/** Raised when the stored pick changes meaning; rows below it re-resolve once at the next backfill.
 * 2: the homepage site icon fills in for a repository with no committed icon file. */
const RESOLVER_REVISION = 2;

/** A repository at least one chat is linked to. Unlinked installed repositories are never read. */
const LINKED = `r.active AND EXISTS (SELECT 1 FROM rooms chat WHERE chat.parent_id IS NULL
  AND chat.repository_resolution='repository' AND chat.repository_name=r.full_name)`;

/**
 * Resolves and stores linked repositories' chat pictures: every one with nothing stored yet or stored by an
 * older resolver (a new link or the one-time backfill), or exactly `repositoryIds` again (a push changed an
 * icon path). The picture is the committed icon file, else the homepage's site icon, else none. A failed
 * GitHub read stores nothing, so the next link or push retries. Returns the chats whose picture changed.
 */
export async function resolveRepositoryIcons(database: SqlDatabase, read: IconRepositoryRead,
  repositoryIds?: readonly string[]): Promise<string[]> {
  const repositories = (await database.query<IconRepository>(
    `SELECT r.repository_id::text repository_id,r.installation_id::text installation_id,r.full_name,r.default_branch,r.homepage
     FROM github_repositories r WHERE ${LINKED} AND (CASE WHEN $1::bigint[] IS NULL
       THEN NOT EXISTS (SELECT 1 FROM repository_icons icon WHERE icon.repository_id=r.repository_id AND icon.resolver_revision>=$2)
       ELSE r.repository_id=ANY($1::bigint[]) END)
     ORDER BY r.repository_id`, [repositoryIds ?? null, RESOLVER_REVISION])).rows;
  const changed: string[] = [];
  for (const repository of repositories) {
    let icon: Awaited<ReturnType<typeof resolveRepositoryIcon>>;
    try {
      icon = await resolveRepositoryIcon(repository.default_branch, path => read(repository, path))
        ?? (repository.homepage ? await resolveHomepageIcon(repository.homepage) : undefined);
    }
    catch (error) { console.warn('[repository-icons] resolve failed', repository.full_name, error); continue; }
    const hash = icon ? createHash('sha256').update(icon.image.bytes).digest('hex') : null;
    const chats = await database.query<{ id: string }>(
      `WITH saved AS (
         INSERT INTO repository_icons(repository_id,icon_path,icon_hash,icon_png,resolver_revision) VALUES($1,$4,$2,$3,$5)
         ON CONFLICT(repository_id) DO UPDATE SET icon_path=EXCLUDED.icon_path,icon_hash=EXCLUDED.icon_hash,icon_png=EXCLUDED.icon_png,
           resolver_revision=EXCLUDED.resolver_revision,resolved_at=now()
         WHERE (repository_icons.icon_path,repository_icons.icon_hash,repository_icons.resolver_revision)
           IS DISTINCT FROM (EXCLUDED.icon_path,EXCLUDED.icon_hash,EXCLUDED.resolver_revision)
         RETURNING repository_id)
       SELECT chat.id FROM saved JOIN github_repositories r USING(repository_id)
       JOIN rooms chat ON chat.parent_id IS NULL AND chat.repository_resolution='repository' AND chat.repository_name=r.full_name`,
      [repository.repository_id, hash, icon?.image.bytes ?? null, icon?.path ?? null, RESOLVER_REVISION]);
    changed.push(...chats.rows.map(chat => chat.id));
  }
  return changed;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The linked repository whose icon a push may have changed: its default branch, with an added, modified or
 * removed path named like an icon or icon source file, or the stored icon's own path (a custom `<link>`
 * target). Any other push leaves the stored picture alone. */
export async function repositoryIconPushTarget(database: SqlDatabase, body: Record<string, unknown>): Promise<string | undefined> {
  const repository = body.repository as { id?: unknown } | undefined;
  if (typeof repository?.id !== 'number' || typeof body.ref !== 'string' || body.deleted === true) return undefined;
  const commits = Array.isArray(body.commits) ? body.commits as Record<string, unknown>[] : [];
  const changed = commits.flatMap(commit => commit ? [...strings(commit.added), ...strings(commit.modified), ...strings(commit.removed)] : []);
  if (!changed.length) return undefined;
  const row = (await database.query<{ repository_id: string; icon_path: string | null }>(
    `SELECT r.repository_id::text repository_id,icon.icon_path FROM github_repositories r
     LEFT JOIN repository_icons icon ON icon.repository_id=r.repository_id
     WHERE r.repository_id=$1 AND 'refs/heads/' || r.default_branch=$2 AND ${LINKED}`, [repository.id, body.ref])).rows[0];
  return row && changed.some(path => isRepositoryIconPath(path) || path === row.icon_path) ? row.repository_id : undefined;
}
