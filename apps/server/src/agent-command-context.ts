import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { createDefaultEmbedFn, type EmbedFn } from './institutional-memory-embeddings.js';
import { getInstitutionalContext } from './institutional-memory-shadow.js';

export const INSTITUTIONAL_CONTEXT_MISSED_TEXT =
  'institutional memory did not load this turn; use search(scope:memory) before concluding anything is not stored.';

/** Freeze the old fact/profile/skill snapshot before commit publishes the queue
 * or an external wake. Private command metadata, never public message text. */
export async function attachQueuedInstitutionalContext(db: SqlDatabase, command: CommandRow, embed: EmbedFn = createDefaultEmbedFn()): Promise<CommandRow> {
  if (command.reason === 'mcp_call' || command.message?.institutionalContext !== undefined) return command;
  let text: string;
  // A failed optional SQL read must not leave the queue transaction aborted.
  await db.query('SAVEPOINT queued_institutional_context');
  try {
    // Avoid provider and authority reads for Workspaces with nothing saved.
    const saved = await db.query(`SELECT 1 FROM rooms room WHERE room.id=$1 AND (
      EXISTS(SELECT 1 FROM workspace_skills skill WHERE skill.workspace_id=room.workspace_id AND skill.state='active') OR
      EXISTS(SELECT 1 FROM institutional_memory_items item WHERE item.workspace_id=room.workspace_id AND item.state='active' AND item.deleted_at IS NULL)
    )`, [command.room_id]);
    text = saved.rowCount ? (await getInstitutionalContext(db, command, embed)).text : '';
    await db.query('RELEASE SAVEPOINT queued_institutional_context');
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT queued_institutional_context');
    await db.query('RELEASE SAVEPOINT queued_institutional_context');
    text = INSTITUTIONAL_CONTEXT_MISSED_TEXT;
    console.warn('[institutional-memory] queued context did not load; delivering the request with a miss notice');
  }
  const message = { ...command.message!, institutionalContext: text };
  await db.query(`WITH updated AS (
    UPDATE agent_commands SET message=$2::jsonb WHERE id=$1 RETURNING id
  ) UPDATE rooms_mcp_event_deliveries SET body=jsonb_set(body::jsonb,'{data,institutionalContext}',to_jsonb($3::text))::text
    WHERE command_id IN (SELECT id FROM updated) AND $3::text<>''`, [command.id, JSON.stringify(message), text]);
  return { ...command, message };
}
