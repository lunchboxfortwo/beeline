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
const authority = turn => ({ roomId: turn.roomId, requestId: turn.turnRequestId, generationId: 'proof' });
const claim = async turn => { await daemon.execute('claimAgentCommand', {
  roomId: turn.roomId, commandId: turn.id, generationId: 'proof' }, turn.agentId); return turn; };
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
  const revision = await claim((await commands(room, boss)).find(c => c.sourceMessageId === approved));
  const historical = await daemon.execute('order', { ...authority(revision), address: opened.cornerId,
    agent: 'worker', text: 'Finish the earlier assignment' }, boss);
  const historicalTurn = await claim((await commands(opened.cornerId, worker)).find(c => c.id === historical.id));
  const dispatch = randomUUID();
  await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'New Dispatch Room')", [dispatch, workspace, human]);
  for (const member of [human, boss]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [workspace, dispatch, member]);
  const dispatchMessage = await message(dispatch, '@boss Apply the approved revised brief');
  const dispatchTurn = await claim((await commands(dispatch, boss)).find(c => c.sourceMessageId === dispatchMessage));
  await daemon.execute('reviseCornerBrief', { ...authority(dispatchTurn), cornerId: opened.cornerId, expectedRevision: 1,
    brief: { spec: 'Build under the new commander', repositoryWork: false, change: 'Human approved handover',
      approval: { sourceMessageId: approved } } }, boss);
  await daemon.execute('report', { ...authority(historicalTurn), status: 'blocked', text: 'Earlier assignment result' }, worker);
  assert.equal((await commands(room, boss)).filter(c => c.reason === 'report' && c.source.body === 'blocked: Earlier assignment result').length, 1);
  assert.equal((await commands(dispatch, boss)).filter(c => c.reason === 'report').length, 0);
  console.log('PASS Reproduction R1 in-flight: incoming commander orders from original Room, revises from another Room, and earlier report returns only to original Room.');
  const wake = await createAgentCommand(db, { roomId: opened.cornerId, agentId: worker, sourceMessageId: null, reason: 'corner_check' });
  const next = await claim((await commands(opened.cornerId, worker)).find(c => c.id === wake.id));
  await assert.rejects(daemon.execute('postCornerMessage', { ...authority(next), cornerId: opened.cornerId,
    text: '@person Choose the endpoint' }, worker), /Your commander is @boss in New Dispatch Room/);
  await daemon.execute('report', { ...authority(next), status: 'blocked', text: 'Endpoint decision required' }, worker);
  assert.equal((await commands(dispatch, boss)).filter(c => c.reason === 'report' && c.source.body === 'blocked: Endpoint decision required').length, 1);
  assert.equal((await commands(dm, opener)).filter(c => c.reason === 'report').length, 0);
  console.log('PASS Reproduction R1: built service human approval → revised brief → worker tag check names new commander → private report received only by new commander.');

  const order = await daemon.execute('order', { ...authority(initial), address: room, agent: 'worker', text: 'Post the result' }, opener);
  const pending = await daemon.execute('order', { ...authority(initial), address: room, agent: 'worker', text: 'Private-only result' }, opener);
  const turn = await claim((await commands(room, worker)).find(c => c.id === order.id));
  const posted = await daemon.execute('postCornerMessage', { ...authority(turn), cornerId: room,
    text: 'The public reply is delivered.' }, worker);
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [dm, opener]);
  const result = await daemon.execute('postRoomMessage', { ...authority(turn), text: 'The public reply is delivered.' }, worker);
  assert.equal(result.id, posted.id);
  assert.match(result.receipt, /Warning:.*public reply was posted.*private report copy was not delivered/);
  assert.deepEqual(await daemon.execute('getRequestCompletion', { roomId: room, requestId: turn.turnRequestId }, worker),
    { completed: true, outcome: 'complete' });
  const view = await phone.readRoom(room, human);
  assert.equal(view.messages.filter(m => m.text === 'The public reply is delivered.').length, 1);
  assert.equal(view.latestAgentTurns.find(t => t.requestId === turn.turnRequestId).status, 'complete');
  console.log('PASS Reproduction R2: built service public post → commander membership removed → final private copy returns success with warning → phone Room read shows one reply and successful turn, no failed turn card.');
  const privateOnly = await claim((await commands(room, worker)).find(c => c.id === pending.id));
  await assert.rejects(daemon.execute('postRoomMessage', { ...authority(privateOnly), text: 'Private-only result' }, worker), /Report was not delivered/);
  console.log('PASS R2 guard: no public post still refuses undelivered private report.');
} finally { await db.close(); }
