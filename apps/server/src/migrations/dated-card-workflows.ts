import type { SqlDatabase } from '../database.js';

/** Owner-approved retirement of the completed November one-off approval cards.
 * Same soft deletion as deleteSkill; retained versions remain pinned run history. */
export async function retireDatedCardWorkflows(database: SqlDatabase): Promise<void> {
  await database.query(`UPDATE workspace_skills
    SET state='archived',revision=revision+1,updated_at=now(),deleted_at=now()
    WHERE workspace_id='18e555f7-e191-452b-9b0f-b825f58ee4ba'
      AND kind='workflow' AND deleted_at IS NULL AND slug IN (
        'insight-card-2026-11-06',
        'insight-card-2026-11-08',
        'insight-card-2026-11-09',
        'morning-card-2026-11-06',
        'morning-card-2026-11-06-r2',
        'morning-card-2026-11-07',
        'morning-card-2026-11-08',
        'morning-card-2026-11-09',
        'morning-card-2026-11-11',
        'morning-card-2026-11-12',
        'morning-card-2026-11-13',
        'morning-card-2026-11-17'
      )`);
}
