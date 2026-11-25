import { expectThreadRouting } from './reply-routing-invariants.test-support.js';
import { commanderChainSql,commanderReportAddress } from './commander.js';
import {
authority,claim,commands,
createAgentCommand,
DM,
expect,
HUMAN,
it,
open,
privateAssignment,
randomBytes,randomUUID,
ROOM,
rootFixture,
RUBY,WORKER,
worker,
WS,
type CommandRow
} from './test-support-commander.integration.test-support.js';

const BOSS = 'f'.repeat(64);

it.each(['approved', 'legacy', 'agent-order', 'different-dispatch', 'same-issuer-in-flight', 'in-flight', 'unapproved'] as const)('Reproduction R1: %s brief revision retains the assigning session', async mode => {
  const approved = mode !== 'unapproved';
  const { db, phone, daemon } = rootFixture;
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Boss','boss') ON CONFLICT DO NOTHING`, [BOSS]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [BOSS, HUMAN]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WS, BOSS, ROOM]);
  const opened = await open(), initial = await worker(opened.cornerId);
  if (mode !== 'in-flight') await daemon.execute('postAgentTurnReceipt', { ...authority(initial), agentId: WORKER, status: 'complete' }, WORKER);
  const messageId = randomBytes(32).toString('hex');
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId, text: '@boss Take over the widget brief' }, HUMAN);
  let returnRoom = ROOM;
  let revisionTurn = (await commands(ROOM, BOSS)).find(c => c.sourceMessageId === messageId)!;
  let historicalOrder: Awaited<ReturnType<typeof commands>>[number] | undefined;
  if (mode === 'same-issuer-in-flight') {
    await claim(revisionTurn);
    const receipt = await daemon.execute('message', { ...authority(revisionTurn), type:'normal', address:`${WORKER}@${opened.cornerId}`, text: 'Finish the earlier assignment' }, BOSS);
    historicalOrder = (await commands(opened.cornerId, WORKER)).find(c => c.id === receipt.id)!;
    await claim(historicalOrder);
  }
  if (mode === 'different-dispatch' || mode === 'same-issuer-in-flight') {
    returnRoom = randomUUID();
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Dispatch Room',$3)`, [returnRoom, WS, HUMAN]);
    for (const member of [HUMAN, BOSS]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [WS, returnRoom, member]);
    const dispatchId = randomBytes(32).toString('hex');
    await phone.execute('sendRoomMessage', { roomId: returnRoom, messageId: dispatchId, text: '@boss Revise the approved brief' }, HUMAN);
    revisionTurn = (await commands(returnRoom, BOSS)).find(c => c.sourceMessageId === dispatchId)!;
  }
  await claim(revisionTurn);
  if (approved) await daemon.execute('reviseCornerBrief', { ...authority(revisionTurn), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Build the widget under the new commander', repositoryWork: false,
      change: 'Human approved commander handover', approval: { sourceMessageId: messageId } } }, BOSS);
  else {
    await expect(daemon.execute('reviseCornerBrief', { ...authority(revisionTurn), cornerId: opened.cornerId,
      expectedRevision: 1, brief: { spec: 'Take over', change: 'No human approval' } }, BOSS)).rejects.toThrow('approval');
  }
  if (mode === 'agent-order') {
    const ordered = await daemon.execute('message', { ...authority(revisionTurn), type:'normal', address:`${RUBY}@${opened.cornerId}`, text: 'Refine the brief without transferring command' }, BOSS);
    const reviser = (await commands(opened.cornerId, RUBY)).find(c => c.id === ordered.id)!;
    await claim(reviser);
    await expect(daemon.execute('reviseCornerBrief', { ...authority(reviser), cornerId: opened.cornerId,
      expectedRevision: 2, brief: { spec: 'Build widget with refined details', repositoryWork: false,
        change: 'Agent-only refinement', approval: { sourceMessageId: ordered.id } } }, RUBY)).rejects.toThrow('commander');
    expect(await commanderReportAddress(db,opened.cornerId)).toMatchObject({recipient:RUBY,returnRoom:DM});
  }
  if (mode === 'legacy') await db.query(`UPDATE corner_brief_revisions
    SET approval_basis=approval_basis-'commanderCommandId'-'commanderReturnRoomId' WHERE corner_id=$1 AND revision=2`, [opened.cornerId]);
  if (historicalOrder) {
    await daemon.execute('postRoomMessage', { ...authority(historicalOrder), text: 'blocked: Earlier same-issuer order result' }, WORKER);
    expect((await db.query('SELECT room_id FROM messages WHERE text=$1',['blocked: Earlier same-issuer order result'])).rows)
      .toEqual([{room_id:opened.cornerId}]);
  }
  if (mode === 'in-flight') {
    const invocation = {id:randomUUID(),requestId:initial.turnRequestId};
    await daemon.execute('startAgentTurn',{...authority(initial),invocationId:invocation.id},WORKER);
    await daemon.execute('message', { ...authority(initial), type:'reply',quoteMsgId:initial.source.id,invocation, text: 'done: Original order result' }, WORKER);
    expect((await commands(DM,RUBY)).filter(c => c.reason === 'reply')).toEqual([
      expect.objectContaining({source:expect.objectContaining({body:'done: Original order result'})})]);
  }
  const wake = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const turn = (await commands(opened.cornerId, WORKER)).find(c => c.id === wake!.id)!;
  await claim(turn);
  const chain = (await db.query<{ id: string }>(`SELECT id FROM rooms corner WHERE corner.id=$1 AND EXISTS (
    SELECT 1 FROM (${commanderChainSql('corner', '$2', 'now()')}) commanders WHERE commanders.id=$3)`, [opened.cornerId, WORKER, BOSS])).rows;
  expect(chain).toEqual([]);
  await daemon.execute('message', { ...authority(turn), type: 'blocked', text: 'Endpoint decision required' }, WORKER);
  const posted = await daemon.execute('postRoomMessage', { ...authority(turn), harnessEnded:true,
    text: '@captain Choose the endpoint' }, WORKER);
  expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [posted.id])).rows[0]?.text)
    .toBe('@captain Choose the endpoint');
  const endpoint = async (agent: string) => (await commands(agent === RUBY ? DM : returnRoom, agent))
    .filter(c => c.reason === 'message' && c.source.body === 'Endpoint decision required');
  expect(await endpoint(RUBY)).toHaveLength(1);
  expect(await endpoint(BOSS)).toEqual([]);
  expect((await commands(opened.cornerId, approved ? BOSS : RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  const saved = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [initial.id])).rows[0]!;
  expect(await commanderReportAddress(db, opened.cornerId, saved)).toMatchObject({ recipient: RUBY, returnRoom: DM });
  await expectThreadRouting(db);
});

it('finishes locally after the assigning session loses access to its return place', async () => {
  const { turn } = await privateAssignment();
  const { db, daemon } = rootFixture;
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  const final = await daemon.execute('postRoomMessage', { ...authority(turn), text: 'The public reply is delivered.' }, WORKER);
  expect((await db.query('SELECT room_id FROM messages WHERE id=$1',[final.id])).rows).toEqual([{room_id:ROOM}]);
  expect(await daemon.execute('getRequestCompletion', { roomId: ROOM, requestId: turn.turnRequestId }, WORKER)).toMatchObject({ completed: true });
  expect((await commands(DM,RUBY)).filter(c => c.reason==='report')).toEqual([]);
});
