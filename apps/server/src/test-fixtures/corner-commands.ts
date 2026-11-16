import { becomeThreadImplementer, createCornerFacts, setCornerLockedFact, setCornerReviewerFact } from '../corner-lifecycle.js';
import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database.js';

// Fixture command rows. Real code creates commands only through
// createAgentCommand (agent-command.ts); these seed completed history.

/**
 * Seed an explicit implementer takeover with completed assignment history.
 * Real person tags do not transfer the role; this fixture wakes nobody.
 */
export async function assignCornerWorker(db: SqlDatabase, cornerId: string, agentId: string): Promise<void> {
  await becomeThreadImplementer(db, cornerId, agentId);
  const id = `assign-${randomUUID()}`;
  await db.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
       root_source_message_id,agent_depth,state,completed_at)
     VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,'complete',now())`,
    [id, cornerId, agentId],
  );
}

/** Seed durable opening provenance without queueing work or a visible transcript. */
export async function seedCornerOpening(database: SqlDatabase, input: {
  cornerId: string;
  agentId?: string | null;
  commissionedBy?: string | null;
  fromRoomId?: string;
  requestId?: string;
  openKey?: string;
}): Promise<string> {
  const id = randomUUID();
  const root = randomUUID();
  if (input.commissionedBy) await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,deleted_at)
     SELECT $1,COALESCE(parent_id,id),$3,'Opening fixture',now() FROM rooms WHERE id=$2`,
    [root, input.cornerId, input.commissionedBy],
  );
  await database.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,
       action,reason,root_command_id,root_source_message_id,agent_depth,state,private_payload)
     SELECT $1,corner.id,COALESCE($3,(SELECT id FROM identities WHERE kind='agent' ORDER BY id LIMIT 1),corner.created_by),
       NULL,$4,'input','corner_objective',$1,$5,0,'complete',
       jsonb_build_object('text','Opening fixture','authorId',corner.created_by,
         'fromRoomId',COALESCE($6,corner.parent_id::text),'kind','order')
         || CASE WHEN $7::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('openKey',$7::text) END
     FROM rooms corner WHERE corner.id=$2`,
    [id,input.cornerId,input.agentId ?? null,input.requestId ?? id,root,input.fromRoomId ?? null,input.openKey ?? null],
  );
  const assigned = (await database.query<{agent_id:string}>('SELECT agent_id FROM agent_commands WHERE id=$1', [id])).rows[0];
  if (assigned) await becomeThreadImplementer(database, input.cornerId, assigned.agent_id);
  return id;
}

/** A fixture corner row with exactly the facts a test names. */
export async function seedCornerFactsRow(
  db: SqlDatabase, cornerId: string, lifecycle: string | null, locked: boolean, reviewerAgentId: string | null,
): Promise<void> {
  await createCornerFacts(db, cornerId);
  const initial = (await db.query<{created_by:string}>(`SELECT r.created_by FROM rooms r
    JOIN corner_facts f ON f.corner_id=r.id WHERE r.id=$1 AND f.implementer_agent_id IS NULL
      AND r.created_by IN (SELECT id FROM identities WHERE kind='agent')`, [cornerId])).rows[0];
  if (initial) await becomeThreadImplementer(db, cornerId, initial.created_by);
  if (locked) await setCornerLockedFact(db, cornerId, locked);
  if (reviewerAgentId) await setCornerReviewerFact(db, cornerId, reviewerAgentId);
  await db.query(
    `INSERT INTO corner_github_cache(corner_id,lifecycle)
     VALUES($1,COALESCE($2::jsonb,'{"lifecycle":"unknown","checks":"unknown"}'::jsonb))
     ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle`,
    [cornerId, lifecycle],
  );
}
