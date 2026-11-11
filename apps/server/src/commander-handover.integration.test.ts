import { randomBytes, randomUUID, expect, it, HUMAN, RUBY, WORKER, WS, ROOM, DM, rootFixture,
  authority, claim, commands, open, worker, privateAssignment, createAgentCommand, type CommandRow } from './test-support-commander.integration.test-support.js';
import { commanderReportAddress, commanderChainSql } from './commander.js';

const BOSS = 'f'.repeat(64);

it.each(['approved', 'legacy', 'agent-order', 'different-dispatch', 'same-issuer-in-flight', 'in-flight', 'unapproved'] as const)('Reproduction R1: %s handover selects commander for reports and human tags', async mode => {
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
    const receipt = await daemon.execute('order', { ...authority(revisionTurn), address: opened.cornerId,
      agent: 'worker', text: 'Finish the earlier assignment' }, BOSS);
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
    const ordered = await daemon.execute('order', { ...authority(revisionTurn), address: opened.cornerId,
      agent: 'ruby', text: 'Refine the brief without transferring command' }, BOSS);
    const reviser = (await commands(opened.cornerId, RUBY)).find(c => c.id === ordered.id)!;
    await claim(reviser);
    const revised = await daemon.execute('reviseCornerBrief', { ...authority(reviser), cornerId: opened.cornerId,
      expectedRevision: 2, brief: { spec: 'Build widget with refined details', repositoryWork: false,
        change: 'Agent-only refinement', approval: { sourceMessageId: ordered.id } } }, RUBY);
    expect(revised.approval?.kind).toBe('commander-order');
  }
  if (mode === 'legacy') await db.query(`UPDATE corner_brief_revisions
    SET approval_basis=approval_basis-'commanderCommandId'-'commanderReturnRoomId' WHERE corner_id=$1 AND revision=2`, [opened.cornerId]);
  if (historicalOrder) {
    await daemon.execute('report', { ...authority(historicalOrder), status: 'blocked', text: 'Earlier same-issuer order result' }, WORKER);
    expect((await commands(ROOM, BOSS)).filter(c => c.reason === 'report')).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ body: 'blocked: Earlier same-issuer order result' }) })]);
    expect((await commands(returnRoom, BOSS)).filter(c => c.reason === 'report')).toEqual([]);
  }
  if (mode === 'in-flight') {
    await daemon.execute('report', { ...authority(initial), status: 'blocked', text: 'Original order result' }, WORKER);
    expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ body: 'blocked: Original order result' }) })]);
    expect((await commands(returnRoom, BOSS)).filter(c => c.reason === 'report')).toEqual([]);
  }
  const wake = await createAgentCommand(db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const turn = (await commands(opened.cornerId, WORKER)).find(c => c.id === wake!.id)!;
  await claim(turn);
  const posted = await daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId,
    text: '@captain Choose the endpoint' }, WORKER);
  expect(posted.receipt).toContain('tag @captain');
  expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [posted.id])).rows[0]?.text)
    .toBe('Choose the endpoint');
  const chain = (await db.query<{ id: string }>(`SELECT id FROM rooms corner WHERE corner.id=$1 AND EXISTS (
    SELECT 1 FROM (${commanderChainSql('corner', '$2', 'now()')}) commanders WHERE commanders.id=$3)`, [opened.cornerId, WORKER, BOSS])).rows;
  expect(chain.length).toBe(approved ? 1 : 0);
  await daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'Endpoint decision required' }, WORKER);
  const reports = (await commands(approved ? returnRoom : DM, approved ? BOSS : RUBY)).filter(c => c.reason === 'report');
  expect(reports).toEqual([expect.objectContaining({ source: expect.objectContaining({ body: 'blocked: Endpoint decision required' }) })]);
  const saved = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [initial.id])).rows[0]!;
  // The original opening assignment remains an in-flight order of the original commander.
  expect(await commanderReportAddress(db, opened.cornerId, saved)).toMatchObject({ recipient: RUBY, returnRoom: DM });
});

it.each(['current', 'other', 'stale', 'none'] as const)('Reproduction R2: missing private-copy recipient with public post=%s', async mode => {
  const posted = mode !== 'none';
  const { turn } = await privateAssignment();
  const { db, daemon } = rootFixture;
  const address = mode === 'other' ? DM : ROOM;
  if (mode === 'other') await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [WS, DM, WORKER]);
  const post = posted ? await daemon.execute('postCornerMessage', { ...authority(turn), cornerId: address,
    text: 'The public reply is delivered.' }, WORKER) : undefined;
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  if (mode === 'stale') await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,
    '{publicPostGenerationId}','"previous-generation"'::jsonb) WHERE id=$1`, [turn.id]);
  const final = daemon.execute('postRoomMessage', { ...authority(turn), text: 'The public reply is delivered.' }, WORKER);
  if (!posted || mode === 'stale') { await expect(final).rejects.toThrow('not delivered'); return; }
  await expect(final).resolves.toMatchObject({ id: post!.id, receipt: expect.stringContaining('Warning:') });
  expect(await daemon.execute('getRequestCompletion', { roomId: ROOM, requestId: turn.turnRequestId }, WORKER))
    .toMatchObject({ completed: true, outcome: 'complete' });
  const view = await rootFixture.phone.readRoom(address, HUMAN);
  expect(JSON.stringify(view)).toContain('The public reply is delivered.');
  const source = await rootFixture.phone.readRoom(ROOM, HUMAN);
  expect(source?.latestAgentTurns?.find(t => t.requestId === turn.turnRequestId)?.status).toBe('complete');
});
