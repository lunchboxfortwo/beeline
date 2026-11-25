// Run with node --import tsx after npm run build --workspace apps/server.
// Isolated database: no daemon, schedule or production state is contacted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migratedDatabase } from '../../apps/server/src/test-support.ts';
import { HelperDaemonService } from '../../apps/server/dist/test-fixtures/helper-daemon.js';
import { AgentScheduleLoop } from '../../apps/server/dist/agent-schedules.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { LiveHub } from '../../apps/server/dist/live.js';

const db = await migratedDatabase();
const owner = 'a'.repeat(64), worker = 'b'.repeat(64);
const workspace = randomUUID(), room = randomUUID(), schedule = randomUUID();
try {
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`, [owner, worker]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [worker, owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Proof')", [room, workspace, owner]);
  for (const member of [owner, worker]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace, room, member]);
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,owner_id,cadence,message,max_runs,next_run_at)
    VALUES($1,$2,$3,$4,$4,$5,'{"kind":"interval","everyMinutes":1}','Check work',1,now()-interval '1 second')`,
    [schedule, workspace, room, worker, owner]);
  const live = new LiveHub(), daemon = new HelperDaemonService(db, live), phone = new PhoneService(db, live);
  assert.equal(await new AgentScheduleLoop(db).runOnce(), 1);
  assert.equal((await db.query('SELECT 1 FROM agent_schedules WHERE id=$1', [schedule])).rowCount, 0);
  const [command] = (await daemon.execute('getAgentCommands', { roomId: room }, worker)).commands;
  await daemon.execute('startAgentTurn', { roomId: room, requestId: command.turnRequestId }, worker);
  const authority = { roomId: room, requestId: command.turnRequestId };
  await daemon.execute('postRoomMessage', { ...authority, text: 'Work complete', harnessEnded: true }, worker);
  const view = await phone.readRoom(room, owner);
  assert.deepEqual(view.messages.filter(row => row.author.pubkey === worker).map(row => row.text), ['Work complete']);
  console.log('PASS The scheduled final appears once in its room after the one-shot schedule is deleted.');
} finally { await db.close(); }
