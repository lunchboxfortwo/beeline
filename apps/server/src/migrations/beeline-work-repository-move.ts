import type { SqlDatabase } from '../database.js';

/** The owner moved every Beeline-Work repository to lunchboxfortwo under the
 * same name. Repoint the Rooms and saved skill versions still naming the
 * retired repositories. Unmatched names are left as they are. */
export async function repointBeelineWorkRepositories(database: SqlDatabase): Promise<void> {
  await database.transaction(async (db) => {
    await db.query(`UPDATE rooms room SET
        repository_key='github:'||moved.repository_id::text,
        repository_name=CASE WHEN room.repository_name IS NULL THEN NULL ELSE moved.full_name END,
        repository_remote=CASE WHEN room.repository_remote IS NULL THEN NULL ELSE 'git://github.com/'||moved.full_name END,
        github_installation_id=CASE WHEN room.github_installation_id IS NULL THEN NULL ELSE moved.installation_id END
      FROM github_repositories retired
      JOIN github_repositories moved ON moved.active
        AND lower(moved.full_name)='lunchboxfortwo/'||lower(split_part(retired.full_name,'/',2))
      WHERE lower(retired.full_name) LIKE 'beeline-work/%'
        AND room.repository_key='github:'||retired.repository_id::text`);
    await db.query(`UPDATE workspace_skills
      SET repository='lunchboxfortwo/'||split_part(repository,'/',2)
      WHERE lower(repository) LIKE 'beeline-work/%'`);
    await db.query(`UPDATE workspace_skill_versions
      SET repository='lunchboxfortwo/'||split_part(repository,'/',2)
      WHERE lower(repository) LIKE 'beeline-work/%'`);
  });
}
