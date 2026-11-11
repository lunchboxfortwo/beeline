import type { SqlDatabase } from '../database.js';
import { deleteUnrealizedAgent } from '../unrealized-agent.js';

// Owner-authorized repair, verified by a read-only production snapshot on 2026-11-11.
const OWNER = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
const MILO = '0e0aa42e01c5972bc5953e13f880aedf2229de917dc0f5bf00ee9a943ec44fdb';
const UNREALIZED = '1461b5d603d04e86ba7b1c843cd25e0e406c79c4c60395e67ff916edad10e3d1';
const WORKSPACE = '18e555f7-e191-452b-9b0f-b825f58ee4ba';

export async function cleanupConnectHandles(database: SqlDatabase) {
  return database.transaction(async db => {
    // Serialize against arrivals and departures before inspecting reservations.
    await db.query(`SELECT w.id FROM workspaces w WHERE w.id=$1 OR EXISTS(
      SELECT 1 FROM workspace_handles h WHERE h.workspace_id=w.id AND NOT EXISTS(
        SELECT 1 FROM memberships m WHERE m.workspace_id=h.workspace_id AND m.identity_id=h.identity_id AND m.removed_at IS NULL))
      ORDER BY w.id FOR UPDATE`, [WORKSPACE]);
    const released = await db.query(`DELETE FROM workspace_handles h WHERE NOT EXISTS(
      SELECT 1 FROM memberships m WHERE m.workspace_id=h.workspace_id
        AND m.identity_id=h.identity_id AND m.removed_at IS NULL) RETURNING workspace_id,identity_id,handle`);
    const target = (await db.query<{ name: string; handle: string; owner_id: string }>(
      `SELECT i.name,h.handle,a.owner_id FROM identities i JOIN agents a ON a.agent_id=i.id
       JOIN workspace_handles h ON h.identity_id=i.id AND h.workspace_id=$2
       WHERE i.id=$1 FOR UPDATE OF i,a`, [MILO,WORKSPACE])).rows[0];
    if (target) {
      if (target.owner_id !== OWNER || target.name !== 'Milo' || !['bruin','milo'].includes(target.handle))
        throw new Error('Milo cleanup target changed; review before repairing');
      await db.query(`INSERT INTO identity_handle_counters(name,n) VALUES('milo',1)
        ON CONFLICT(name) DO UPDATE SET n=greatest(identity_handle_counters.n,excluded.n)`);
      if ((await db.query(`SELECT 1 FROM workspace_handles WHERE workspace_id=$1 AND handle='milo' AND identity_id<>$2
        UNION ALL SELECT 1 FROM identities WHERE kind='human' AND lower(handle)='milo'`, [WORKSPACE,MILO])).rowCount)
        throw new Error('Milo still has an active handle collision; review before repairing');
      await db.query(`UPDATE workspace_handles SET handle='milo' WHERE workspace_id=$1 AND identity_id=$2 AND handle<>'milo'`, [WORKSPACE,MILO]);
      await db.query(`UPDATE identities SET workspace_handle_base='milo',updated_at=now()
        WHERE id=$1 AND workspace_handle_base IS DISTINCT FROM 'milo'`, [MILO]);
    }
    const ghost = (await db.query<{ name: string; handle: string; owner_id: string }>(
      `SELECT i.name,i.handle,a.owner_id FROM identities i JOIN agents a ON a.agent_id=i.id WHERE i.id=$1`, [UNREALIZED])).rows[0];
    if (ghost) {
      if (ghost.owner_id !== OWNER || ghost.name !== 'Milo' || ghost.handle !== 'echo_5')
        throw new Error('Unrealized connect cleanup target changed; review before deleting');
      await deleteUnrealizedAgent(db, UNREALIZED);
    }
    return { released: released.rows, repairedMilo: Boolean(target), deletedUnrealized: Boolean(ghost) };
  });
}
