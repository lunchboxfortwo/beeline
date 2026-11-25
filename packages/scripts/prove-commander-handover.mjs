// Run with node --import tsx after building api-contract and server.
// Isolated built-service proof: never changes a live corner or production data.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migratedDatabase } from '../../apps/server/src/test-support.ts';
import { HelperDaemonService } from '../../apps/server/dist/test-fixtures/helper-daemon.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { createAgentCommand } from '../../apps/server/dist/agent-command.js';
import { LiveHub } from '../../apps/server/dist/live.js';

const db = await migratedDatabase();
const human = 'a'.repeat(64), opener = 'b'.repeat(64), boss = 'c'.repeat(64), worker = 'd'.repeat(64);
const workspace = randomUUID(), room = randomUUID(), dm = randomUUID();
const daemon = new HelperDaemonService(db, new LiveHub()), phone = new PhoneService(db, 'http://proof');
const commands = async (address, agent) => (await daemon.execute('getAgentCommands', { roomId: address }, agent)).commands;
const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId });
const claim = async turn => { await daemon.execute('startAgentTurn', { roomId: turn.roomId, requestId: turn.turnRequestId }, turn.agentId); return turn; };
const message = async (address, text) => {
  const messageId = randomBytes(32).toString('hex');
  await phone.execute('sendRoomMessage', { roomId: address, messageId, text }, human);
  return messageId;
};
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),
    ($2,'agent','Opener','opener'),($3,'agent','Boss','boss'),($4,'agent','Worker','worker')`, [human, opener, boss, worker]);
  for (const agent of [opener, boss, worker]) await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants)
    VALUES($1,$3,$4,'Proof Room',NULL),($2,$3,$4,'Opening DM',jsonb_build_array($4::text,$5::text))`, [room, dm, workspace, human, opener]);
  for (const member of [human, opener, boss, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, member]);
    if ([human, opener].includes(member)) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [workspace, dm, member]);
  }
  await message(dm, 'Build the widget');
  const initial = await claim((await commands(dm, opener))[0]);
  const opened = await daemon.execute('createCorner', { ...authority(initial), targetRoomId: room,
    name: 'Widget', objective: 'Build the widget', implementer: 'worker', brief: { spec: 'Build widget', repositoryWork: false,
      approval: { sourceMessageId: initial.sourceMessageId } } }, opener);
  const original = await claim((await commands(opened.cornerId, worker))[0]);
  await daemon.execute('postAgentTurnReceipt', { ...authority(original), agentId: worker, status: 'complete' }, worker);
  const approved = await message(room, '@boss Take over the brief');
  await claim((await commands(room, boss)).find(c => c.sourceMessageId === approved));
  const dispatch = randomUUID();
  await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'New Dispatch Room')", [dispatch, workspace, human]);
  for (const member of [human, boss]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [workspace, dispatch, member]);
  const dispatchMessage = await message(dispatch, '@boss Apply the approved revised brief');
  const dispatchTurn = await claim((await commands(dispatch, boss)).find(c => c.sourceMessageId === dispatchMessage));
  await daemon.execute('reviseCornerBrief', { ...authority(dispatchTurn), cornerId: opened.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the revised widget', repositoryWork: false, change: 'Human approved the revision',
      approval: { sourceMessageId: approved } } }, boss);
  const wake = await createAgentCommand(db, { roomId: opened.cornerId, agentId: worker, sourceMessageId: null, reason: 'corner_check' });
  const next = await claim((await commands(opened.cornerId, worker)).find(c => c.id === wake.id));
  const block = await daemon.execute('message', { ...authority(next), type: 'blocked', text: 'Endpoint decision required' }, worker);
  assert((await commands(dm, opener)).some(c => c.id === block.id));
  assert(!(await commands(dispatch, boss)).some(c => c.id === block.id));
  await daemon.execute('postRoomMessage', { ...authority(next), text: 'Checked the endpoint', harnessEnded: true }, worker);
  const posts = await db.query('SELECT room_id FROM messages WHERE author_id=$1 AND text=$2', [worker, 'Checked the endpoint']);
  assert.deepEqual(posts.rows, [{room_id:opened.cornerId}]);
  console.log('PASS After a brief revision the opener receives the block in its original DM and the final stays in the thread.');
} finally { await db.close(); }
