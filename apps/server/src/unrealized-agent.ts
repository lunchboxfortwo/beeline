import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity } from './system-line.js';
import { revokeDaemonCredentials } from './daemon-credential-lifetime.js';

/** The caller owns the transaction. A failed connect may discard setup, never work. */
export async function deleteUnrealizedAgent(database: SqlDatabase, agentId: string): Promise<void> {
  await database.query(`SELECT w.id FROM workspaces w WHERE EXISTS(
    SELECT 1 FROM memberships m WHERE m.workspace_id=w.id AND m.identity_id=$1)
    ORDER BY w.id FOR UPDATE`, [agentId]);
  await database.query(`SELECT id FROM identities WHERE id=$1 AND kind='agent' FOR UPDATE`, [agentId]);
  const ran = await database.query(`SELECT 1 FROM live_outputs WHERE agent_id=$1
    UNION ALL SELECT 1 FROM agent_commands WHERE agent_id=$1
    UNION ALL SELECT 1 FROM agent_turns WHERE agent_id=$1
    UNION ALL SELECT 1 FROM messages WHERE author_id=$1
      AND (presentation='system' AND card_type='member-joined') IS NOT TRUE LIMIT 1`, [agentId]);
  if (ran.rowCount) throw new Error('agent already ran; use removeAgent instead');
  await revokeDaemonCredentials(database, agentId);
  await database.query(`DELETE FROM push_outbox WHERE message_id IN (SELECT id FROM messages WHERE author_id=$1)`, [agentId]);
  await database.query(`DELETE FROM push_message_context WHERE message_id IN (SELECT id FROM messages WHERE author_id=$1)`, [agentId]);
  await database.query(`DELETE FROM push_turn_context WHERE author_id=$1`, [agentId]);
  const notices = await database.query(`SELECT 1 FROM messages WHERE author_id=$1 LIMIT 1`, [agentId]);
  if (notices.rowCount) {
    // A generated join can already be the source of somebody else's command.
    // Keep its ID and those commands, but hide the unrealized arrival.
    await ensureSystemIdentity(database);
    await database.query(`UPDATE messages SET author_id=$2,deleted_at=COALESCE(deleted_at,now())
      WHERE author_id=$1 AND presentation='system' AND card_type='member-joined'`, [agentId,SYSTEM_IDENTITY_ID]);
  }
  await database.query(`DELETE FROM agent_pairing_codes WHERE claimed_by=$1`, [agentId]);
  // Native cascades remove only this identity's setup rows and reservations.
  await database.query(`DELETE FROM identities WHERE id=$1 AND kind='agent'`, [agentId]);
}
