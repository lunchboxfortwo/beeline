import type { AgentCommand } from '@beeline/api-contract/daemon';
import { randomBytes,randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,expect,it } from 'vitest';
import { cornerImplementerSql } from './corner-worker.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { PgliteDatabase,migratedDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64), JELLYBEAN = 'b'.repeat(64), BABY = 'c'.repeat(64), CANDY = 'd'.repeat(64), EARTH = 'e'.repeat(64);
const AGENTS = [JELLYBEAN, BABY, CANDY, EARTH];
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;
let order: AgentCommand;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Jellybean','jellybean'),($3,'agent','Baby','baby'),
    ($4,'agent','Candy','candy'),($5,'agent','Earth','earth')`, [OWNER, ...AGENTS]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$5),($2,$5),($3,$5),($4,$5)`, [...AGENTS, OWNER]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Order target proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'beeline',NULL,$4),($2,$3,'Owner and Jellybean',jsonb_build_array($4::text,$5::text),$4)`,
    [ROOM, DM, WS, OWNER, JELLYBEAN]);
  for (const person of [OWNER, ...AGENTS])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, person, ROOM]);
  for (const person of [OWNER, JELLYBEAN])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, person]);
  await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Get Candy to look at the build' }, OWNER);
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, JELLYBEAN)).commands[0]!;
  await startQueuedCommand(daemon, { roomId: DM, commandId: order.id }, JELLYBEAN);
});
const authority = () => ({ roomId: order.roomId, requestId: order.turnRequestId });
const orderWakes = async () => (await db.query<{ agent_id: string; room_id: string }>(
  `SELECT agent_id,room_id FROM agent_commands WHERE reason='order' ORDER BY agent_id`)).rows;

it('an unnamed Room order gives target-selection feedback and leaves the issuer request queued', async () => {
  for (const text of ['Candy only: check the build','Baby only: rerun the proof','Candy only: post the URL','Baby only: stop']) {
    const result=await daemon.execute('order',{...authority(),address:ROOM,text},JELLYBEAN) as {feedback?:string};
    expect(result.feedback).toMatch(/^name which agent this order is for: /);
    for (const handle of ['baby','candy','earth']) expect(result.feedback).toContain(`@${handle}`);
  }
  expect(await orderWakes()).toEqual([]);
  expect((await daemon.execute('getAgentCommands',{},JELLYBEAN)).commands).toHaveLength(1);
});

it('wakes only the named agent at a Room address, by handle, @handle or id', async () => {
  await daemon.execute('order', { ...authority(), address: ROOM, agent: '@candy', text: 'Candy only: check the build' }, JELLYBEAN);
  expect(await orderWakes()).toEqual([{ agent_id: CANDY, room_id: ROOM }]);
  await daemon.execute('order', { ...authority(), address: ROOM, agent: BABY, text: 'Baby only: rerun the proof' }, JELLYBEAN);
  expect((await orderWakes()).map(row => row.agent_id).sort()).toEqual([BABY, CANDY].sort());
  console.info('Demonstrated room-broadcast: agent=@candy woke Candy only; agent=<Baby id> woke Baby only; Earth never woken');
});

it('refuses a Room order naming a non-member or a human', async () => {
  for (const agent of ['nobody', 'owner'])
    await expect(daemon.execute('order', { ...authority(), address: ROOM, agent, text: 'Do it' }, JELLYBEAN)).rejects.toMatchObject({kind:'membership'});
  expect(await orderWakes()).toEqual([]);
});

it('queues an explicit self-order from the DM into the Room', async () => {
  const result = await daemon.execute('order', { ...authority(), address: ROOM, agent: 'jellybean', text: 'Continue in the Room' }, JELLYBEAN);
  expect(await orderWakes()).toEqual([{ agent_id: JELLYBEAN, room_id: ROOM }]);
  expect((await daemon.execute('getAgentCommands', { roomId: ROOM }, JELLYBEAN)).commands.find(c => c.id === result.id)).toMatchObject({ source: { body: 'Continue in the Room' } });
});

it('allows named corner peers and preserves agent DM orders', async () => {
  const opened = await daemon.execute('createCorner', { ...authority(), targetRoomId: ROOM, name: 'Widget',
    objective: 'Build the widget', implementer: 'candy',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, JELLYBEAN);
  // The opening order stays: it is what names Candy the corner's worker.
  await db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND reason<>'corner_objective'`, [opened.cornerId]);
  await daemon.execute('order', { ...authority(), address: opened.cornerId, text: 'Use the new endpoint' }, JELLYBEAN);
  expect(await orderWakes()).toEqual([{ agent_id: CANDY, room_id: opened.cornerId }]);
  await daemon.execute('order', { ...authority(), address: opened.cornerId, agent: 'baby', text: 'Replay the path' }, JELLYBEAN);
  expect((await orderWakes()).some(row => row.agent_id === BABY)).toBe(true);

  const agentDM = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Jellybean and Earth',jsonb_build_array($3::text,$4::text))`, [agentDM, WS, JELLYBEAN, EARTH]);
  for (const agent of [JELLYBEAN, EARTH]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, agentDM, agent]);
  await daemon.execute('order', { ...authority(), address: agentDM, text: 'Research the endpoint' }, JELLYBEAN);
  expect((await orderWakes()).filter(row => row.room_id === agentDM)).toEqual([{ agent_id: EARTH, room_id: agentDM }]);
  expect((await orderWakes()).filter(row => row.agent_id === BABY)).toEqual([{ agent_id: BABY, room_id: opened.cornerId }]);
});

it.each(['corner', 'parent Room'])('Reproduction corner-peer-orders: %s order preserves the opening commander', async target => {
  const opened = await daemon.execute('createCorner', { ...authority(), targetRoomId: ROOM, name: 'peer-orders',
    objective: 'Prove peer orders', implementer: 'candy',
    brief: { spec: 'Prove peer orders', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, JELLYBEAN);
  const incoming = (await daemon.execute('getAgentCommands', { roomId: opened.cornerId }, CANDY)).commands[0]!;
  await startQueuedCommand(daemon, { roomId: opened.cornerId, commandId: incoming.id }, CANDY);
  const address = target === 'corner' ? opened.cornerId : ROOM;
  const receipt = await daemon.execute('order', { roomId: opened.cornerId, requestId: incoming.turnRequestId, address, agent: 'baby', text: 'Replay the user path' }, CANDY);
  const assigned = (await daemon.execute('getAgentCommands', { roomId: address }, BABY)).commands.find(c => c.id === receipt.id)!;
  expect(assigned).toMatchObject({ private: true, source: { authorId: CANDY, body: 'Replay the user path' } });
  await startQueuedCommand(daemon, { roomId: address, commandId: assigned.id }, BABY);
  await daemon.execute('report', { roomId: address, requestId: assigned.turnRequestId, status: 'done', text: 'done: replay passed' }, BABY);
  const recipient = target === 'corner' ? JELLYBEAN : CANDY;
  // Either way the commander's report wake lands in the corner the work concerns.
  const destination = opened.cornerId;
  const replies = (await daemon.execute('getAgentCommands', { roomId: destination }, recipient)).commands;
  expect(replies.find(c => c.reason === 'report')).toMatchObject({ private: true,
    source: { authorId: BABY, body: 'done: replay passed' } });
  expect((await db.query(`SELECT agent_id,room_id FROM agent_commands WHERE reason='report'`)).rows)
    .toEqual([{ agent_id: recipient, room_id: destination }]);
  expect((await db.query(`SELECT ${cornerImplementerSql('f', 'c')} worker_agent_id FROM corner_facts f JOIN rooms c ON c.id=f.corner_id WHERE f.corner_id=$1`, [opened.cornerId])).rows[0]?.worker_agent_id).not.toBe(BABY);

});

async function cornerTurn() {
  const opened = await daemon.execute('createCorner', { ...authority(), targetRoomId: ROOM, name: 'peer-guards',
    objective: 'Prove peer guards', implementer: 'candy',
    brief: { spec: 'Prove peer guards', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } } }, JELLYBEAN);
  const command = (await daemon.execute('getAgentCommands', { roomId: opened.cornerId }, CANDY)).commands[0]!;
  await startQueuedCommand(daemon, { roomId: opened.cornerId, commandId: command.id }, CANDY);
  return command;
}

it('RUBY-18: an explicit re-review reaches the configured reviewer at the chain depth bound', async () => {
  const incoming = await cornerTurn();
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, BABY]);
  await db.query(`UPDATE agent_commands SET agent_depth=3 WHERE id=$1`, [incoming.id]);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [incoming.roomId, JSON.stringify({ pr: { number: 42, headSha: 'a'.repeat(40) } })]);
  // The commander may be handling the reviewer's earlier verdict report.
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [incoming.id,
    JSON.stringify({ cornerId: incoming.roomId, headSha: 'a'.repeat(40), pullRequest: 42, briefRevision: 1, purpose: 'verdict' })]);
  const result = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent: 'baby', text: 'Re-review the restored PR body on the same head' }, CANDY);
  const review = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, BABY)).commands.find(command => command.id === result.id)!;
  expect(review.source.body).toContain('Re-review the restored PR body');
  expect((await db.query<{ agent_depth: number }>(`SELECT agent_depth FROM agent_commands WHERE id=$1`, [review.id])).rows[0]!.agent_depth).toBe(4);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [review.id]);
  const tagged = await daemon.execute('postCornerMessage', { roomId: incoming.roomId, requestId: incoming.turnRequestId, cornerId: incoming.roomId, text: '@baby Re-review the restored evidence' }, CANDY);
  expect(tagged.woken).toEqual([]);
  const message=await daemon.execute('message',{roomId:incoming.roomId,requestId:incoming.turnRequestId,to:{agent:'reviewer',place:incoming.roomId},text:'Re-review the restored evidence'},CANDY);
  expect((await daemon.execute('getAgentCommands',{roomId:incoming.roomId},BABY)).commands.some(command=>command.id===message.id && command.reason==='message')).toBe(true);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1 AND agent_id=$2`, [incoming.roomId, BABY]);
  await db.query(`UPDATE agent_commands SET review_context=jsonb_set(review_context,'{purpose}','"repair"') WHERE id=$1`, [incoming.id]);
  const rereview = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent: 'baby', text: 'Re-review after the evidence-only repair' }, CANDY);
  const delivered = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, BABY)).commands.find(command => command.id === rereview.id)!;
  expect(delivered).toBeDefined();
  await startQueuedCommand(daemon, { roomId: incoming.roomId, commandId: delivered.id }, BABY);
  const peer = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent: 'earth', text: 'Recruit a peer' }, CANDY);
  expect((await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, EARTH)).commands.map(c => c.id)).toContain(peer.id);
});

it.each(['done', 'blocked', 'failed', 'needs_decision'])('Reproduction report-commander-refused: repair %s reaches its opening commander after a new head', async status => {
  const incoming = await cornerTurn();
  const context = { cornerId: incoming.roomId, headSha: 'old-head', pullRequest: 42, briefRevision: 1 };
  await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_build_object('pr',jsonb_build_object('number',42,'headSha','old-head')) WHERE corner_id=$1`, [incoming.roomId]);
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [incoming.id, JSON.stringify(context)]);
  const receipt = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent: 'baby', text: 'Repair this head' }, CANDY);
  const assigned = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, BABY)).commands.find(c => c.id === receipt.id)!;
  await startQueuedCommand(daemon, { roomId: assigned.roomId, commandId: assigned.id }, BABY);
  await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}','"new-head"') WHERE corner_id=$1`, [incoming.roomId]);
  const text = `${status.replace('_', '-')}: repair result`;
  await daemon.execute('report', { roomId: assigned.roomId, requestId: assigned.turnRequestId, status, text }, BABY);
  const reply = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, JELLYBEAN)).commands.find(c => c.reason === 'report')!;
  expect(reply).toMatchObject({ private: true, source: { authorId: BABY, body: text } });
  await startQueuedCommand(daemon, { roomId: reply.roomId, commandId: reply.id }, JELLYBEAN);
  expect((await db.query(`SELECT state,parent_command_id,review_context FROM agent_commands WHERE id=$1`, [reply.id])).rows[0])
    .toMatchObject({ state: 'pending', parent_command_id: order.id, review_context: null });
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE reason='report' AND agent_id=$1`, [CANDY])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM messages WHERE text=$1`, [text])).rowCount).toBe(0);
  // A changed head remains context; it cannot discard a report.
  await daemon.execute('report', { roomId: incoming.roomId, requestId: incoming.turnRequestId, status: 'done', text: 'done: stale review verdict' }, CANDY);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [incoming.id])).rows).toEqual([{ state: 'complete' }]);
  expect((await db.query(`SELECT 1 FROM agent_commands WHERE private_payload->>'text' LIKE 'done: stale review verdict%'`)).rowCount).toBe(1);
  console.info(`Demonstrated Reproduction report-commander-refused: ${status} after repair delivered privately and claimed by opening commander`);
});

it('Reproduction report-commander-refused: a current reviewer report keeps its own head across an older repair parent', async () => {
  const incoming = await cornerTurn();
  await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_build_object('pr',jsonb_build_object('number',42,'headSha','new-head')) WHERE corner_id=$1`, [incoming.roomId]);
  const context = { cornerId: incoming.roomId, headSha: 'new-head', pullRequest: 42, briefRevision: 1 };
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [incoming.id, JSON.stringify(context)]);
  const receipt = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent: 'baby', text: 'Review the replacement head' }, CANDY);
  // A fresh review can be resumed from an older repair order, as in the incident.
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [incoming.id, JSON.stringify({ ...context, headSha: 'old-head', purpose: 'repair' })]);
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [receipt.id, JSON.stringify(context)]);
  const assigned = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, BABY)).commands.find(c => c.id === receipt.id)!;
  await startQueuedCommand(daemon, { roomId: assigned.roomId, commandId: assigned.id }, BABY);
  await daemon.execute('report', { roomId: assigned.roomId, requestId: assigned.turnRequestId, status: 'done', text: 'done: current review complete' }, BABY);
  const reply = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, JELLYBEAN)).commands.find(c => c.reason === 'report')!;
  expect(reply).toMatchObject({ source: { authorId: BABY, body: expect.stringContaining('done: current review complete') } });
  expect((await db.query(`SELECT review_context FROM agent_commands WHERE id=$1`, [reply.id])).rows[0]?.review_context)
    .toMatchObject({ ...context, purpose: 'verdict' });
  await startQueuedCommand(daemon, { roomId: reply.roomId, commandId: reply.id }, JELLYBEAN);
});

it('keeps membership walls while allowing explicit corner self-orders', async () => {
  const incoming = await cornerTurn();
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, EARTH]);
  const before = await orderWakes();
  for (const agent of ['owner', 'nobody', 'earth'])
    await expect(daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent, text: 'Do it' }, CANDY)).rejects.toMatchObject({kind:'membership'});
  expect(await orderWakes()).toEqual(before);
  for (const agent of ['candy', CANDY, undefined]) {
    const result = await daemon.execute('order', { roomId: incoming.roomId, requestId: incoming.turnRequestId, address: incoming.roomId, agent, text: `Continue ${agent}` }, CANDY);
    expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [result.id])).rows).toEqual([{ state: 'pending' }]);
  }
});

it.each(['corner', 'parent Room'])('retains every corner → %s → corner order beyond the former depth bound', async target => {
  let command = await cornerTurn();
  const corner = command.roomId;
  const depths: number[] = [];
  for (let hop = 0; hop < 6; hop++) {
    const recipient = command.agentId === CANDY ? BABY : CANDY;
    const address = recipient === BABY && target === 'parent Room' ? ROOM : corner;
    const result = await daemon.execute('order', { roomId: command.roomId, requestId: command.turnRequestId, address, agent: recipient, text: `Loop hop ${hop}` }, command.agentId);
    depths.push((await db.query<{ agent_depth: number }>(`SELECT agent_depth FROM agent_commands WHERE id=$1`, [result.id])).rows[0]!.agent_depth);
    command = (await daemon.execute('getAgentCommands', { roomId: address }, recipient)).commands.find(c => c.id === result.id)!;
    await startQueuedCommand(daemon, { roomId: address, commandId: command.id }, recipient);
  }
  expect(depths).toEqual([1, 2, 3, 4, 5, 6]);
  const result = await daemon.execute('order', { roomId: command.roomId, requestId: command.turnRequestId, address: target === 'corner' ? corner : ROOM, agent: BABY, text: 'Another hop' }, CANDY);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [result.id])).rows).toEqual([{ state: 'pending' }]);
});

it.each(['done', 'blocked', 'failed', 'needs_decision'].flatMap(status => [JELLYBEAN, OWNER, EARTH].map(commander => ({ status, commander }))))('HANDBACK-ROUTE-1: implementer handback $status (commander=$commander) reaches the right recipient', async ({ status, commander }) => {
  const incoming = await cornerTurn();
  // Baby reviews Candy's work; Jellybean remains the corner commander.
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, BABY]);
  const { createAgentCommand } = await import('./agent-command.js');
  const context = { cornerId: incoming.roomId, headSha: 'head', pullRequest: 42, briefRevision: 1 };
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [incoming.roomId, JSON.stringify({ pr: { number: 42, headSha: 'head' } })]);
  if (commander !== JELLYBEAN) await createAgentCommand(db, { id: randomBytes(32).toString('hex'),
    roomId: incoming.roomId, agentId: CANDY, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', authorId: commander, fromRoomId: commander === OWNER ? DM : ROOM, text: 'Continue under my order' } });
  const review = await createAgentCommand(db, { id: randomBytes(32).toString('hex'), roomId: incoming.roomId,
    agentId: BABY, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', authorId: JELLYBEAN, fromRoomId: DM, text: 'Review the change' } });
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [review!.id, JSON.stringify(context)]);
  const reviewer = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, BABY)).commands.find(c => c.id === review!.id)!;
  await startQueuedCommand(daemon, { roomId: reviewer.roomId, commandId: reviewer.id }, BABY);
  await daemon.execute('order', { roomId: reviewer.roomId, requestId: reviewer.turnRequestId, address: incoming.roomId, text: 'FAIL: repair the missing proof' }, BABY);
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [incoming.id]);
  const repair = (await daemon.execute('getAgentCommands', { roomId: incoming.roomId }, CANDY)).commands.find(c => c.reason === 'order' && c.source.authorId === BABY)!;
  await startQueuedCommand(daemon, { roomId: repair.roomId, commandId: repair.id }, CANDY);
  await daemon.execute('report', { roomId: repair.roomId, requestId: repair.turnRequestId, status, text: `${status.replace('_', '-')}: repair result` }, CANDY);
  const recipient = JELLYBEAN;
  const destination = incoming.roomId;
  expect((await db.query(`SELECT agent_id,room_id FROM agent_commands WHERE reason='report'`)).rows)
    .toEqual([{ agent_id: recipient, room_id: destination }]);
});
