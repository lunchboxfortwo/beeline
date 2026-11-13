// Local stand-ins for production-only races, against the compiled server and phone socket.
// Run after npm run build --workspace apps/server, with node --import tsx.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresDatabase, migrate } from '../apps/server/dist/database.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { refreshCornerAttention } from '../apps/server/dist/corner-attention.js';
import { AuthStore } from '@beeline/auth/store';
import { phoneFetch } from '../tests/helpers/phone-operation.ts';
import { seedCornerOpening } from '../apps/server/src/test-fixtures/corner-commands.ts';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
assert(url && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Use isolated loopback PostgreSQL');
const admin = new Pool({ connectionString: url });
const name = `sentry_proof_${randomUUID().replaceAll('-', '')}`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
await admin.query(`CREATE DATABASE ${name}`);
const pool = new Pool({ connectionString: isolated.toString(), max: 4 });
const database = new PostgresDatabase('', 4, { pool });
let server;
try {
  await migrate(database);
  await new AuthStore(database).migrate();
  const owner = createHash('sha256').update('github:proof-owner').digest('hex');
  const partner = 'c'.repeat(64), agent = 'b'.repeat(64);
  const workspace = randomUUID(), room = randomUUID(), corner = randomUUID(), dm = randomUUID();
  await database.query(`INSERT INTO identities(id,kind,name,github_subject) VALUES
    ($1,'human','Proof owner','proof-owner'),($2,'human','Partner',NULL),($3,'agent','Worker',NULL)`, [owner, partner, agent]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, partner]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await database.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)", [room, workspace, partner]);
  await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [corner, workspace, room, agent]);
  await database.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [corner]);
  await seedCornerOpening(database, { cornerId: corner, agentId: agent, commissionedBy: partner });
  await database.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Direct message',$3::jsonb)`, [dm, workspace, JSON.stringify([owner, partner])]);
  for (const id of [owner, partner, agent]) await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, id, room]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [workspace, dm, owner, partner]);
  await database.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Preserved message')", ['a'.repeat(64), dm, owner]);

  const auth = new TokenAuth(database, async () => ({ subject: 'proof-owner', login: 'proof-owner', name: 'Proof owner' }));
  const token = (await auth.exchangeGitHubOidc('local-proof')).accessToken;
  const transact = database.transaction.bind(database);
  let deletionAttempts = 0;
  const faulting = {
    query: database.query.bind(database),
    transaction: work => transact(tx => {
      deletionAttempts++;
      return work({ transaction: tx.transaction.bind(tx), query: async (sql, args) => {
        const result = await tx.query(sql, args);
        if (deletionAttempts === 1 && sql.startsWith('UPDATE messages SET author_id='))
          await tx.query("DO $$ BEGIN RAISE EXCEPTION 'forced deadlock rollback' USING ERRCODE='40P01'; END $$");
        return result;
      } });
    }),
  };
  const live = new LiveHub();
  const phone = new PhoneService(faulting, 'http://localhost');
  server = createBeelineServer({ database, auth, phone, daemon: new DaemonService(database, live), live, mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await phoneFetch(`${origin}/v1/phone/operations/deleteAccount`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
  });
  assert.equal(response.status, 204, await response.text());
  assert.equal(deletionAttempts, 2);
  assert.equal((await database.query('SELECT 1 FROM identities WHERE id=$1', [owner])).rowCount, 0);
  assert.equal((await database.query('SELECT 1 FROM messages WHERE id=$1 AND author_id<>$2', ['a'.repeat(64), owner])).rowCount, 1);
  assert.deepEqual((await database.query('SELECT direct_participants FROM rooms WHERE id=$1', [dm])).rows[0].direct_participants, [partner]);
  console.log('Demonstrated SENTRY-4P: phone socket returns deletion success after one SQL deadlock rollback; shared message and remaining DM participant survive.');

  await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
    VALUES($1,'held-turn',$2,'working','held-generation')`, [corner, agent]);
  const turnWriter = await pool.connect(), lifecycleWriter = await pool.connect();
  let refreshAttempts = 0;
  try {
    await turnWriter.query('BEGIN');
    await turnWriter.query('SELECT 1 FROM agent_turns WHERE room_id=$1 FOR UPDATE', [corner]);
    await lifecycleWriter.query('BEGIN');
    await lifecycleWriter.query('SELECT 1 FROM corner_facts WHERE corner_id=$1 FOR UPDATE', [corner]);
    const refreshing = {
      query: database.query.bind(database),
      transaction: work => transact(async tx => {
        refreshAttempts++;
        await tx.query("SET LOCAL lock_timeout='100ms'");
        return work(tx);
      }).catch(async error => { await lifecycleWriter.query('ROLLBACK'); throw error; }),
    };
    assert.deepEqual(await refreshCornerAttention(refreshing, corner), { parentId: room });
    assert.equal(refreshAttempts, 2);
    const listed = await new PhoneService(database, origin).readCorners(room, partner);
    assert(listed.corners.some(item => item.corner.id === corner));
    console.log('Demonstrated SENTRY-4B: after a real lifecycle lock timeout, one retry completes and the phone lists the corner while its turn row remains locked.');
  } finally {
    await lifecycleWriter.query('ROLLBACK'); await turnWriter.query('ROLLBACK');
    lifecycleWriter.release(); turnWriter.release();
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await database.close();
  await admin.query(`DROP DATABASE ${name}`); await admin.end();
}
