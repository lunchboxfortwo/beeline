// Isolated built-service proof; never executes the requested script or changes production grants.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migratedDatabase } from '../apps/server/src/test-support.ts';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
const db = await migratedDatabase();
const owner = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  workspace = randomUUID(),
  room = randomUUID(),
  grant = randomUUID();
try {
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Proof','proof')`,
    [owner, agent],
  );
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')", [
    room,
    workspace,
  ]);
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,
    [workspace, room, owner, agent],
  );
  const target = JSON.stringify({ argv: ['bash'], stdin: 'printf check' });
  const script = { path: '<stdin>', sha256: 'a'.repeat(64), bytes: 12, contents: 'printf check' };
  await db.query(
    `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,script) VALUES($1,$2,$3,'command',$4,'Check',$5,$6,'pending',$7::jsonb)`,
    [grant, agent, workspace, target, owner, room, JSON.stringify(script)],
  );
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Check','card','grant-request',$4::jsonb)`,
    [
      'c'.repeat(64),
      room,
      agent,
      JSON.stringify({
        agent: { pubkey: agent, kind: 'agent', name: 'Proof' },
        grants: [{ grantId: grant, kind: 'command', target, script, status: 'pending' }],
      }),
    ],
  );
  const phone = new PhoneService(db, new LiveHub());
  const view = await phone.execute('readNeedsYou', { workspaceId: workspace }, owner);
  assert.deepEqual(
    view.items[0].approval.actions.map((x) => x.label),
    ['Always', 'Once', 'Deny'],
  );
  await phone.execute('decideAgentGrant', { grantId: grant, decision: 'once' }, owner);
  assert.equal(
    (await db.query('SELECT status FROM agent_grants WHERE id=$1', [grant])).rows[0].status,
    'once',
  );
  assert.equal(
    (await phone.execute('readNeedsYou', { workspaceId: workspace }, owner)).items.length,
    0,
  );
  console.log(
    'PASS Reproduction COMMAND-ONCE-1: built phone service offers Always, Once, Deny for bash stdin; Once persists as once and settles the tray.',
  );
} finally {
  await db.close();
}
