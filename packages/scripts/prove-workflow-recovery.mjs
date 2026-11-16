// Run after npm run build -w @beeline/server with node --import tsx.
// Uses only an isolated database and built services; never contacts a live daemon.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migratedDatabase, insertCornerFacts } from '../../apps/server/src/test-support.ts';
import { HelperDaemonService } from '../../apps/server/dist/test-fixtures/helper-daemon.js';
import { createAgentCommand } from '../../apps/server/dist/agent-command.js';
import { AgentScheduleLoop } from '../../apps/server/dist/agent-schedules.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { LiveHub } from '../../apps/server/dist/live.js';

const db = await migratedDatabase();
const owner = 'a'.repeat(64), worker = 'b'.repeat(64), approver = 'c'.repeat(64);
const workspace = randomUUID(), room = randomUUID(), corner = randomUUID();
const live = new LiveHub(), daemon = new HelperDaemonService(db, live), phone = new PhoneService(db, live);
async function turn(address, agent, text, ordered = false) {
  const source = randomBytes(32).toString('hex');
  await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)', [source,address,owner,text]);
  const command = await createAgentCommand(db, { roomId: address, agentId: agent, sourceMessageId: source,
    reason: ordered ? 'order' : 'human_message', ...(ordered ? {
      privatePayload: { kind: 'order', authorId: owner, fromRoomId: room, text },
    } : {}) });
  const generationId = randomUUID();
  await daemon.execute('claimAgentCommand', { roomId: address, commandId: command.id, generationId }, agent);
  return { roomId: address, requestId: command.turn_request_id, generationId };
}
try {
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker'),($3,'agent','Approver')`, [owner,worker,approver]);
  for (const agent of [worker,approver]) await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent,owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Recovery proof')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Proof Room')", [room,workspace,owner]);
  await db.query("INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'Proof corner',$4)", [corner,workspace,owner,room]);
  await insertCornerFacts(db, { cornerId: corner, ownerAgentId: worker, commissionedBy: owner });
  for (const member of [owner,worker,approver]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace,room,member]);
  const context = await turn(corner,worker,'Start the recovery proof',true);
  await daemon.execute('saveWorkflow', { ...context, contract: {
    version: 1, name: 'recovery-proof', description: 'Demonstrate workflow recovery', summary: 'Recover a failed gate and answer from its parent Room.',
    roles: ['worker','approver'], start: 'work', handoffs: {
      work: { role: 'worker', does: 'Complete the work once.', requires: ['note'], on: { ready: 'approve', timeout: 'failed' }, timeoutSeconds: 60 },
      approve: { kind: 'gate', role: 'approver', does: 'Ask a person to publish.', requires: ['decision'], on: { publish: 'done', reject: 'failed' }, default: 'reject', timeoutSeconds: 60 },
      done: { kind: 'terminal', does: 'Finish the run.', status: 'done' },
      failed: { kind: 'terminal', does: 'Record the failure.', status: 'failed' },
    },
  } }, worker);
  const { runId } = await daemon.execute('startWorkflow', { ...context, name: 'recovery-proof', roleBindings: { worker,approver } }, worker);
  await daemon.execute('handoff', { ...context, runId, outcome: 'ready', contents: { note: 'Work completed once' } }, worker);
  await daemon.execute('postRoomMessage', { ...context, text: 'Work is ready for approval' }, worker);
  assert.equal((await db.query('SELECT status FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [context.requestId,worker])).rows[0].status,'complete');
  const transcript = await phone.readRoom(corner,owner);
  assert(!transcript.latestAgentTurns.some(turn => turn.agentPubkey === worker && turn.status === 'working'));
  const cards = transcript.messages.filter(m => m.systemEvent?.kind === 'workflow-handoff');
  assert.equal(cards.length,2);
  assert(cards.every(m => m.presentation === 'card'));
  console.log('PASS Reproduction 13: ordered corner final reply is visible to the phone and its turn is already complete, without a helper terminal receipt.');
  console.log('PASS Reproduction 8: phone transcript contains typed compact handoff cards, with report contents outside their header.');
  await db.query(`UPDATE messages SET created_at=now()-interval '9 hours' WHERE card->>'runId'=$1`, [runId]);
  await new AgentScheduleLoop(db).runOnce();
  const expired = await phone.execute('readWorkflowRun', { roomId: corner,runId },owner);
  assert.equal(expired.run.status,'failed');
  console.log('PASS Reproduction 8: the built timeout loop makes an overdue gate read as failed on the phone, without choosing its default.');
  const recovery = await turn(corner,worker,'Resume the failed gate');
  await daemon.execute('assignWorkflowRole', { ...recovery,runId,role: 'approver',targetAgentId: approver },worker);
  const resumed = await phone.execute('readWorkflowRun', { roomId: corner,runId },owner);
  assert.equal(resumed.run.status,'live');
  assert.equal(resumed.run.state,'approve');
  assert.equal(resumed.history.at(-1).toState,'approve');
  assert(resumed.history.length >= expired.history.length);
  await daemon.execute('postRoomMessage', { ...recovery,text: 'Gate resumed' },worker);
  const answer = await turn(room,approver,'publish for the exact recovery run');
  await daemon.execute('handoff', { ...answer,runId,outcome: 'publish',contents: {} },approver);
  const finished = await phone.execute('readWorkflowRun', { roomId: corner,runId },owner);
  assert.equal(finished.run.status,'done');
  assert.equal((await db.query(`SELECT count(*)::int n FROM messages WHERE card->>'runId'=$1 AND card->>'toState'='work'`, [runId])).rows[0].n,1);
  console.log('PASS Reproduction 8: rebind restores the failed gate with history; a human parent-Room answer finishes that exact run, without repeating its successful work step.');
} finally { await db.close(); }
