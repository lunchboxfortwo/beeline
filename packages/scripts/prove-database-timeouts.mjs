// Reproduction db-lock-1 against the built service and isolated loopback PostgreSQL.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { PostgresDatabase, migrate } from '../../apps/server/dist/database.js';
import { DatabaseLockDiagnostics } from '../../apps/server/dist/database-lock-diagnostics.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { DaemonService } from '../../apps/server/dist/daemon-service.js';
import { TokenAuth } from '../../apps/server/dist/auth.js';
import { createBeelineServer } from '../../apps/server/dist/server.js';
import { LiveHub } from '../../apps/server/dist/live.js';
import { refreshCornerAttention } from '../../apps/server/dist/corner-attention.js';
import { AuthStore } from '@beeline/auth/store';
import { phoneFetch } from '../test-helpers/helpers/phone-operation.ts';
import { seedCornerOpening } from '../../apps/server/src/test-fixtures/corner-commands.ts';
const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
assert(url && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const admin = new Pool({ connectionString: url });
const name = `lock_proof_${randomUUID().replaceAll('-', '')}`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
await admin.query(`CREATE DATABASE ${name}`);
const config = { connectionString: isolated.toString(), max: 1, connectionTimeoutMillis: 150, options: '-c lock_timeout=500ms' };
const observer = new PostgresDatabase('', 1, { pool: new Pool(config) });
const pool = new Pool(config);
const diagnostics = new DatabaseLockDiagnostics(observer);
const database = new PostgresDatabase('', 1, { pool, lockDiagnostics: diagnostics });
const concurrentRequest = new PostgresDatabase('', 1, { pool: new Pool(config), lockDiagnostics: diagnostics });
const holders = new Pool(config);
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args); originalWarn(...args); };
let server, holder, reserved, socket;
try {
  await migrate(database); await new AuthStore(database).migrate();
  const owner = createHash('sha256').update('github:db-lock-proof').digest('hex');
  const agent = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID(), corner = randomUUID();
  await database.query("INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','db-lock-proof'),($2,'agent','Worker',NULL)", [owner, agent]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, owner]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await database.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)", [room, workspace, owner]);
  await database.query("INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)", [corner, workspace, room, agent]);
  await database.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [corner]);
  for (const id of [owner, agent]) await database.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')", [workspace,id,room]);
  await seedCornerOpening(database, { cornerId: corner, agentId: agent, commissionedBy: owner });
  const auth = new TokenAuth(database, async () => ({ subject:'db-lock-proof', login:'proof', name:'Proof' }));
  const token = (await auth.exchangeGitHubOidc('local-proof')).accessToken;
  const live = new LiveHub();
  server = createBeelineServer({ database, auth, phone:new PhoneService(database,'http://localhost'), daemon:new DaemonService(database,live), live, mediaMaximumBytes:1024 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = op => phoneFetch(`${origin}/v1/phone/operations/${op}`, { method:'POST', headers:{authorization:`Bearer ${token}`}, body:JSON.stringify({roomId:room}) });

  holder = await holders.connect();
  await holder.query('BEGIN');
  await holder.query("SELECT corner_id FROM corner_facts WHERE corner_id=$1 AND 'private-body-secret'<>'' FOR UPDATE",[corner]);
  const refreshing = assert.rejects(refreshCornerAttention(database,corner), {code:'55P03'});
  // Normal concurrent request traffic admits an observation during the live wait.
  await observer.query('SELECT pg_sleep(0.15)');
  await concurrentRequest.query('SELECT 1');
  await refreshing;
  const lock = warnings.find(([label]) => label === '[database] lock timeout')?.[1];
  assert.equal(lock?.observation,'captured');
  assert.match(lock.blockers[0].query,/SELECT corner_id FROM corner_facts/);
  assert(!JSON.stringify(lock).includes('private-body-secret'));
  // The review reproduction uses standard strings whose closing quote follows
  // a backslash. Exercise both sides of the compiled diagnostic log boundary.
  const sensitiveSql = String.raw`SELECT corner_id, 'ends-with-backslash\', 'private-message-secret' FROM corner_facts WHERE corner_id=$1 FOR UPDATE`;
  await holder.query('SET LOCAL standard_conforming_strings=on');
  await holder.query(sensitiveSql, [corner]);
  const waiting = assert.rejects(database.query(sensitiveSql, [corner]), { code: '55P03' });
  await observer.query('SELECT pg_sleep(0.15)');
  await concurrentRequest.query('SELECT 1');
  await waiting;
  const redacted = warnings.filter(([label]) => label === '[database] lock timeout').at(-1)?.[1];
  assert.equal(redacted.observation, 'captured');
  assert.equal(redacted.statement, '[SQL redacted]');
  assert.equal(redacted.blockers[0].query, '[SQL redacted]');
  assert(!JSON.stringify(redacted).includes('private-message-secret'));
  await holder.query('ROLLBACK'); holder.release(); holder = undefined;
  await refreshCornerAttention(database,corner);
  const listed = await request('readCorners');
  assert.equal(listed.status,200,await listed.clone().text());
  assert((await listed.json()).corners.some(item => item.corner.id === corner));
  console.log('db-lock-1: built background lifecycle contention logs the planted holder; after holder release, the phone socket lists the corner. Historical holder remains unknown.');

  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${token}`]);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const socketRead = () => new Promise((resolve, reject) => {
    const id = `read-${sequence++}`;
    const receive = raw => {
      const frame = JSON.parse(String(raw));
      if (frame.t !== 'res' || frame.id !== id) return;
      socket.off('message', receive); resolve(frame);
    };
    socket.on('message', receive); socket.once('error', reject);
    socket.send(JSON.stringify({ t:'req', id, op:'readRoom', args:{roomId:room} }));
  });
  reserved = await database.connectDedicated();
  const refused = await socketRead();
  assert.equal(refused.ok,false,JSON.stringify(refused));
  assert.equal(refused.error.retryable,true,JSON.stringify(refused));
  const occupancy = warnings.find(([label]) => label === '[database] connection wait timeout')?.[1];
  assert.equal(occupancy.inUse,1); assert.equal(typeof occupancy.waiting,'number');
  reserved.release(); reserved = undefined;
  const loaded = await socketRead();
  assert.equal(loaded.ok,true,JSON.stringify(loaded));
  console.log('db-lock-1: a real exhausted pool makes phone readRoom return unavailable with occupancy diagnostics; returning its connection lets the same socket operation load the Room.');
} finally {
  if (reserved) reserved.release();
  if (holder) { await holder.query('ROLLBACK'); holder.release(); }
  if (socket) socket.terminate();
  if (server) await new Promise(resolve => server.close(resolve));
  console.warn = originalWarn;
  await database.close(); await concurrentRequest.close(); await observer.close(); await holders.end();
  await admin.query(`DROP DATABASE ${name}`); await admin.end();
}
