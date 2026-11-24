import { expectThreadRouting } from './reply-routing-invariants.test-support.js';
import { commanderReportAddress,reportToCommander } from './commander.js';
import { closeBlock } from './implementer-blocks.js';
import { advanceCorner } from './corner-lifecycle.js';
import { readWorkThread } from './work-board.js';
import {
authority,claim,commands,
createAgentCommand,
DM,
expect,
HUMAN,
it,
open,
randomBytes,
ROOM,
rootFixture,
RUBY,WORKER,
worker,
type CommandRow
} from './test-support-commander.integration.test-support.js';

it.each((['Room', 'DM'] as const).flatMap(surface => (['blocked', 'needs_decision', 'failed', 'done'] as const).map(status => ({ surface, status }))))('opening commander $status escalation returns to the original $surface even from inside the corner', async ({ surface, status }) => {
  if (surface === 'Room') {
    const messageId = randomBytes(32).toString('hex');
    await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId, text: '@ruby Build the widget' }, HUMAN);
    rootFixture.order = (await commands(ROOM, RUBY)).find(command => command.sourceMessageId === messageId)!;
    await claim(rootFixture.order);
  }
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'An endpoint decision is needed' }, WORKER);
  const sourceRoom = surface === 'Room' ? ROOM : DM;
  const handback = (await commands(sourceRoom, RUBY)).find(command => command.reason === 'report')!;
  expect(handback).toMatchObject({ private: true, source: { authorId: WORKER } });
  expect((await commands(opened.cornerId,RUBY)).filter(command => command.reason === 'report')).toEqual([]);

  await closeBlock(rootFixture.db,WORKER,handback.id,'The commander answered');
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@worker inspect the blocker' }, HUMAN);
  const inspection = (await commands(opened.cornerId, WORKER)).find(command => command.sourceMessageId === messageId)!;
  await claim(inspection);
  const result = await rootFixture.daemon.execute('reply', { ...authority(inspection), id:inspection.id,
    text: `${status.replace('_','-')}: inspected` }, WORKER);
  expect((await rootFixture.db.query("SELECT room_id,card->'route'->'to' recipient FROM messages WHERE id=$1",[result.id])).rows)
    .toEqual([{room_id:opened.cornerId,recipient:{agent:HUMAN,place:opened.cornerId}}]);
});

it('later human orders get ordinary replies here while escalations still go to the opening commander', async () => {
  const opened = await open(), initial = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId, text: '@worker explain your endpoint choice' }, HUMAN);
  const turn = (await commands(opened.cornerId, WORKER)).find(command => command.sourceMessageId === messageId)!;
  await claim(turn);
  const reply = await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn),
    text: '@captain The endpoint requires a decision from the opening commander.' }, WORKER);
  expect((await rootFixture.db.query(`SELECT room_id FROM messages WHERE id=$1`, [reply.id])).rows).toEqual([{ room_id: opened.cornerId }]);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
  const wake = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const resumed = (await commands(opened.cornerId, WORKER)).find(command => command.id === wake!.id)!;
  await claim(resumed);
  await rootFixture.daemon.execute('report', { ...authority(resumed), status: 'blocked', text: 'Choose the endpoint' }, WORKER);
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report'))
    .toEqual([expect.objectContaining({ source: expect.objectContaining({ authorId: WORKER, body: 'blocked: Choose the endpoint' }) })]);
  const saved = (await rootFixture.db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [turn.id])).rows[0];
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId, saved))
    .toMatchObject({ recipient: HUMAN, returnRoom: opened.cornerId });
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId))
    .toMatchObject({ recipient: RUBY, returnRoom: DM });
});

it('preserves public post text while the report keeps its recorded escalation address', async () => {
  const opened = await open();
  const command = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: RUBY,
    sourceMessageId: null, reason: 'corner_check' });
  const turn = (await commands(opened.cornerId, RUBY)).find(turn => turn.id === command!.id)!;
  await claim(turn);
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId,
    text: '@captain Choose the endpoint' }, RUBY);
  expect(posted.receipt).toContain('Message stored and visible.');
  expect((await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [posted.id])).rows[0]?.text)
    .toBe('@captain Choose the endpoint');
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
});

it.each([false, true])('nested corners report one step up even with opening parent removed=%s', async removed => {
  const outer = await open(), parentTurn = await worker(outer.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(parentTurn), targetRoomId: ROOM,
    idempotencyKey: 'nested-opening', name: 'Nested', objective: 'Check the nested work', implementer: 'ruby',
    brief: { spec: 'Check the nested work', repositoryWork: false } }, WORKER);
  const assignment = (await commands(child.cornerId, RUBY)).find(command => command.reason === 'corner_objective')!;
  if (removed) await rootFixture.db.query(`UPDATE agent_commands SET parent_command_id=NULL WHERE id=$1`, [assignment.id]);
  const opener = (await rootFixture.db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [parentTurn.id])).rows[0]!;
  expect(await commanderReportAddress(rootFixture.db, child.cornerId, opener))
    .toMatchObject({ recipient: WORKER, returnRoom: outer.cornerId });
  await claim(assignment);
  await rootFixture.daemon.execute('report', { ...authority(assignment), status: 'blocked', text: 'Nested decision needed' }, RUBY);
  // The outer worker commands the nested corner, so the nested report wakes it there.
  const report = (await commands(outer.cornerId, WORKER)).find(command => command.reason === 'report')!;
  expect(report).toMatchObject({ private: true, source: { authorId: RUBY, body: 'blocked: Nested decision needed' } });
  expect((await commands(DM, RUBY)).filter(command => command.reason === 'report')).toEqual([]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(parentTurn), agentId: WORKER, status: 'complete' }, WORKER);
  await claim(report);
  await rootFixture.daemon.execute('report', { ...authority(report), status: 'needs_decision', text: 'Nested decision needed' }, WORKER);
  expect((await commands(DM, RUBY)).find(command => command.reason === 'report'))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'needs-decision: Nested decision needed' } });
});

it('a stale recipient field cannot redirect a worker report into the corner', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const result = await rootFixture.daemon.execute('report', { ...authority(turn), status: 'needs_decision',
    text: 'Choose the endpoint', to: '@captain' } as never, WORKER);
  expect((await commands(DM, RUBY)).find(command => command.id === result.id))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'needs-decision: Choose the endpoint' } });
  expect((await rootFixture.db.query(`SELECT id FROM messages WHERE id=$1 AND presentation='message' AND block_corner_id IS NOT NULL`, [result.id])).rows).toEqual([{id:result.id}]);
});

it('a self-opened thread keeps the task sender as commander and never wakes itself', async () => {
  const opened = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    name: 'Self-opened', objective: 'Check self-opened reports', implementer: 'ruby',
    brief: { spec: 'Check self-opened reports', repositoryWork: false,
      approval: { sourceMessageId: rootFixture.order.sourceMessageId } } }, RUBY);
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId)).toMatchObject({ recipient: HUMAN, returnRoom: DM });
  const report = await reportToCommander(rootFixture.db, opened.cornerId, WORKER, 'blocked: reviewer unavailable');
  expect((await commands(DM, RUBY)).find(command => command.id === report.id)).toBeUndefined();
  expect((await rootFixture.db.query('SELECT room_id,author_id FROM messages WHERE id=$1',[report.id])).rows).toEqual([{room_id:DM,author_id:WORKER}]);
  const opening = (await rootFixture.db.query<CommandRow>(`SELECT * FROM agent_commands
    WHERE room_id=$1 AND reason='corner_objective'`, [opened.cornerId])).rows[0]!;
  expect(await commanderReportAddress(rootFixture.db, opened.cornerId, opening)).toMatchObject({ recipient: HUMAN, returnRoom: DM });
});

it('Reproduction archived-return: an answer to a closed commander corner ends its item and the opened corner rests idle', async () => {
  const outer = await open(), parentTurn = await worker(outer.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(parentTurn), targetRoomId: ROOM,
    idempotencyKey: 'archived-return', name: 'Delegated', objective: 'Add the provider', implementer: 'ruby',
    brief: { spec: 'Add the provider', repositoryWork: false } }, WORKER);
  const assignment = (await commands(child.cornerId, RUBY)).find(command => command.reason === 'corner_objective')!;
  expect((await rootFixture.db.query(`SELECT return_room_id FROM agent_commands WHERE id=$1`, [assignment.id])).rows)
    .toEqual([{ return_room_id: outer.cornerId }]);
  await claim(assignment);
  // The commander closes its own corner right after delegating.
  await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [outer.cornerId]);
  await expect(rootFixture.daemon.execute('reply', { ...authority(assignment), id:assignment.id,
    text: 'blocked: no repository source here' }, RUBY)).resolves.toMatchObject({ id: assignment.id });
  expect((await rootFixture.db.query(`SELECT state,cancellation_reason FROM agent_commands WHERE id=$1`, [assignment.id])).rows)
    .toEqual([{ state: 'cancelled', cancellation_reason: 'return_address_archived' }]);
  expect((await commands(child.cornerId, RUBY)).map(command => command.id)).not.toContain(assignment.id);
  await advanceCorner(rootFixture.db, child.cornerId, { kind: 'reconcile' });
  expect((await rootFixture.db.query(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`, [child.cornerId])).rows)
    .toEqual([{ state: 'idle' }]);
  expect((await readWorkThread(rootFixture.db, child.cornerId, HUMAN))[0]).toMatchObject({ state: 'in-progress', idle: true });
});

it('a worker self-opening a nested fix retains its own issuer', async () => {
  const outer=await open(), parent=await worker(outer.cornerId);
  const child=await rootFixture.daemon.execute('createCorner',{...authority(parent),targetRoomId:ROOM,
    name:'Fix',objective:'Resolve the triaged issue',implementer:'worker',brief:{spec:'Resolve the issue',repositoryWork:false}},WORKER);
  const objective=(await commands(child.cornerId,WORKER)).find(command=>command.reason==='corner_objective')!;
  await claim(objective);
  const result=await rootFixture.daemon.execute('reply',{...authority(objective),id:objective.id,text:'done: fixed'},WORKER);
  expect((await commands(DM,RUBY)).find(command=>command.id===result.id)?.from).toEqual({agent:WORKER,place:child.cornerId});
});

it('prints three self-opened thread turns locally and reports to the person who issued the order', async () => {
  const child=await rootFixture.daemon.execute('createCorner',{...authority(rootFixture.order),targetRoomId:ROOM,
    name:'Counts',objective:'Count the widgets',implementer:'ruby',brief:{spec:'Count the widgets',repositoryWork:false}},RUBY);
  const objective=(await commands(child.cornerId,RUBY)).find(command=>command.reason==='corner_objective')!;
  for (let i=0;i<3;i++) {
    const id=i===0 ? objective.id : (await createAgentCommand(rootFixture.db,{roomId:child.cornerId,agentId:RUBY,
      sourceMessageId:null,reason:'corner_check'}))!.id;
    await rootFixture.daemon.execute('postRoomMessage',{roomId:child.cornerId,requestId:id,text:`Count result ${i}`},RUBY);
  }
  const result=await rootFixture.daemon.execute('reply',{roomId:child.cornerId,id:objective.id,text:'done: counted'},RUBY);
  expect((await rootFixture.db.query("SELECT room_id FROM messages WHERE author_id=$1 AND text LIKE 'Count result %'",[RUBY])).rows)
    .toEqual(Array(3).fill({room_id:child.cornerId}));
  expect((await rootFixture.db.query("SELECT card->'route'->'to' recipient FROM messages WHERE id=$1",[result.id])).rows)
    .toEqual([{recipient:{agent:HUMAN,place:DM}}]);
  await expectThreadRouting(rootFixture.db);
});

it.each(['blocked','done','question','legacy'])('an agent-issued order survives a worker self-open for %s', async kind => {
  const order=await rootFixture.daemon.execute('message',{...authority(rootFixture.order),to:{agent:WORKER,place:ROOM},text:'Check inventory'},RUBY);
  const work=(await commands(ROOM,WORKER)).find(item=>item.id===order.id)!;
  await claim(work);
  const child=await rootFixture.daemon.execute('createCorner',{...authority(work),targetRoomId:ROOM,
    name:'Inventory',objective:'Check inventory',implementer:'worker',brief:{spec:'Check inventory',repositoryWork:false}},WORKER);
  const objective=(await commands(child.cornerId,WORKER)).find(command=>command.reason==='corner_objective')!;
  await claim(objective);
  const context=authority(objective);
  const result=kind==='legacy' ? await rootFixture.daemon.execute('report',{...context,status:'done',text:'Checked'},WORKER)
    : await rootFixture.daemon.execute('reply',{...context,id:objective.id,text:kind==='question'?'needs-decision: Which stockroom?':`${kind}: checked`,
      ...(kind==='question'?{ask:{question:'Which stockroom?',options:['East','West']}}:{})},WORKER);
  expect((await commands(DM,RUBY)).find(command=>command.id===result.id)?.from).toEqual({agent:WORKER,place:child.cornerId});
  expect((await rootFixture.db.query('SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2',[child.cornerId,RUBY])).rows).toEqual([]);
  const local=await rootFixture.daemon.execute('postRoomMessage',{...context,text:'Inventory notes',harnessEnded:true},WORKER);
  expect((await rootFixture.db.query('SELECT room_id FROM messages WHERE id=$1',[local.id])).rows).toEqual([{room_id:child.cornerId}]);
  await expectThreadRouting(rootFixture.db);
});
