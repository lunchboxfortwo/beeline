import { cornerLifecycleSql } from './corner-github-cache.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { cornerImplementerSql } from './corner-worker.js';
import type { CornerMachine } from './corner-machine.js';

export type CornerRow = {
  machine: CornerMachine | null;
  parent_id: string;
  worker_agent_id: string | null;
  lifecycle: CornerLifecycleView;
  archived: boolean;
  locked: boolean;
  configured_reviewer_id: string | null;
  configured_reviewer_kind: string | null;
  configured_reviewer_name: string | null;
  /** Changes on every committed write to the corner row; advanceCorner compares it. */
  row_version?: string;
};


export async function loadCorner(db: SqlDatabase, cornerId: string, retain: boolean | 'skip-locked' = true): Promise<CornerRow | undefined> {
  db = new CornerAccessDatabase(db);
  return (
    await db.query<CornerRow>(
      `SELECT fact.machine,corner.parent_id,
              ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
              ${cornerLifecycleSql('fact.corner_id')},fact.locked,
              corner.archived_at IS NOT NULL archived,
              ${cornerReviewerSql()} configured_reviewer_id,
              configured.kind configured_reviewer_kind,
              configured.name configured_reviewer_name,
              fact.xmin::text row_version
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN identities configured ON configured.id=${cornerReviewerSql()}
       WHERE fact.corner_id=$1
       ${retain === 'skip-locked' ? 'FOR UPDATE OF fact SKIP LOCKED' : retain ? 'FOR UPDATE OF fact' : ''}`,
      [cornerId],
    )
  ).rows[0];
}


export * from './corner-machine.js';
