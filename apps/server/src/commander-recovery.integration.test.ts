import { claimAgentConnection } from './connection-presence.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { DM,DaemonService,GITHUB_SUBJECT,HUMAN,LiveHub,MemoryObjectStorage,ObjectService,PushDeliveryLoop,ROOM,RUBY,WORKER,WS,advanceCorner,authority,claim,commands,createAgentCommand,expect,it,open,randomBytes,randomUUID,releaseAgentConnection,rootFixture,systemLine,vi,worker,type AgentCommand } from './test-support-commander-recovery.integration.test-support.js';

it('RUBY-16: report files stay in the immutable private queue snapshot', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const bytes = Buffer.from('native review evidence');
  const uploaded = await objects.uploadArtifact(WORKER, bytes, 'text/plain', 'proof.txt');
  const attachment = { url: uploaded.url, name: 'proof.txt', mimeType: 'text/plain', size: bytes.length };
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
  await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: proof attached' }, WORKER);
  const reviewer = '16'.repeat(32);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Reviewer')`, [reviewer]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [reviewer, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [WS, ROOM, reviewer]);
  const privateReport=(await commands(opened.cornerId,RUBY)).find(command=>command.reason==='report')!;
  expect(privateReport.source.attachments).toEqual([expect.objectContaining(attachment)]);
  await expect(rootFixture.daemon.execute('getRoomMessage', {
    roomId: opened.cornerId, messageId: privateReport.id,
  }, reviewer)).rejects.toThrow('message access denied');
});

it('RUBY-19: a member reading a chat without a brief gets an empty revision list', async () => {
  await expect(rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId: ROOM }, RUBY))
    .resolves.toEqual({ revisions: [] });
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
  await expect(rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId: ROOM }, RUBY))
    .rejects.toThrow('daemon chat access denied');
});



it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: independent reports retain every file through %s', async (delivery) => {
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const attachments = [];
  const turns = [];
  const corners: string[] = [];
  // Both workers finish before the commander consumes either report.
  for (const name of ['first.txt', 'second.txt']) {
    const opened = await open(name);
    const turn = await worker(opened.cornerId);
    corners.push(opened.cornerId);
    const bytes = Buffer.from(`${delivery}:${name}`);
    const uploaded = await objects.uploadArtifact(WORKER, bytes, 'text/plain', name);
    const attachment = { url: uploaded.url, name, mimeType: 'text/plain', size: bytes.length };
    attachments.push(attachment);
    await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
    turns.push(turn);
  }
  for (const [index, turn] of turns.entries()) {
    await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: `done: attached ${attachments[index]!.name}` }, WORKER);
  }
  // Each report wakes the commander in its own corner.
  const reports = [];
  for (const corner of corners) reports.push(...(await commands(corner, RUBY)).filter(c => c.reason === 'report'));
  expect(reports).toHaveLength(2);
  for (const [index, report] of reports.entries()) {
    expect(report.source.attachments).toEqual([attachments[index]]);
    await claim(report);
    if (delivery === 'report')
      await rootFixture.daemon.execute('report', { ...authority(report), status: 'done', text: `done: attached ${attachments[index]!.name}` }, RUBY);
    else await rootFixture.daemon.execute('postRoomMessage', { ...authority(report), text: `Attached ${attachments[index]!.name}` }, RUBY);
  }
  const visible = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(message => message.attachments?.length);
  expect(visible).toHaveLength(2);
  for (const [index, message] of visible.entries()) {
    expect(message.attachments).toEqual([expect.objectContaining(attachments[index])]);
    const readable = await rootFixture.daemon.execute('getRoomMessage', { roomId: DM, messageId: message.id }, RUBY);
    expect(readable.attachments).toEqual([expect.objectContaining(attachments[index])]);
    const attachment = readable.attachments[0]!;
    expect(Buffer.from((await objects.readOwnedBytes(WORKER, attachment.url.split('/').at(-1)!))!).toString())
      .toBe(`${delivery}:${attachment.name}`);
  }
});


it.each(['report', 'postRoomMessage'] as const)('Reproduction FILE-HANDOFF: %s keeps files on their own commander route', async delivery => {
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const commanders = ['12'.repeat(32), '13'.repeat(32)];
  const incoming = [];
  for (const commander of commanders) {
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Commander') ON CONFLICT DO NOTHING`, [commander]);
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [commander, HUMAN]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [WS, ROOM, commander]);
    const parent = (await createAgentCommand(rootFixture.db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: commander, fromRoomId: ROOM, text: 'Prepare my file' },
    }))!;
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [parent.id]);
    const name = `${commander.slice(0, 2)}.txt`;
    // Distinct objects with identical bytes also exercise deduplication after routing.
    const uploaded = await objects.uploadArtifact(commander, Buffer.from(`private-${delivery}`), 'text/plain', name);
    incoming.push({ parent, attachment: { url: uploaded.url, name, mimeType: 'text/plain', size: Buffer.byteLength(`private-${delivery}`) } });
  }
  for (const { parent, attachment } of incoming) {
    await createAgentCommand(rootFixture.db, {
      roomId: ROOM, agentId: RUBY, sourceMessageId: null, reason: 'report', parent, retainDepth: true,
      privatePayload: { kind: 'report', authorId: WORKER, fromRoomId: ROOM, text: 'done: file ready', attachments: [attachment] },
    });
  }
  const reports = (await commands(ROOM, RUBY)).filter(command => command.reason === 'report');
  expect(reports).toHaveLength(2);
  for (const report of reports) {
    expect(report.source.attachments).toHaveLength(1);
    await claim(report);
    if (delivery === 'report')
      await rootFixture.daemon.execute('report', { ...authority(report), status: 'done', text: 'done: file attached' }, RUBY);
    else await rootFixture.daemon.execute('postRoomMessage', { ...authority(report), text: 'File attached' }, RUBY);
  }
  for (const [index, commander] of commanders.entries()) {
    const delivered = (await commands(ROOM, commander)).find(command => command.reason === 'report')!;
    expect(delivered.source.attachments).toEqual([incoming[index]!.attachment]);
    const read = await rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commander);
    expect(read.attachments).toEqual([expect.objectContaining(incoming[index]!.attachment)]);
    await expect(rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: delivered.id }, commanders[1 - index]!))
      .rejects.toThrow('message access denied');
  }
});


it('reports a later corner order to the opening commander', async () => {
  const opened = await open();
  const OTHER = 'd'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other')`, [OTHER]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [OTHER, HUMAN]);
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,
    [WS, ROOM, OTHER],
  );
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('second-command',$1,$2,'Follow up')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: OTHER,
    sourceMessageId: 'second-command',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: OTHER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'order',
    { roomId: ROOM, requestId: incoming.turn_request_id, address: opened.cornerId, text: 'Other requests a follow-up' },
    OTHER,
  );
  const turn = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'order')!;
  await claim(turn);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: Other follow-up' }, WORKER);
  expect((await commands(opened.cornerId, RUBY)).some((c) => c.source.body === 'done: Other follow-up')).toBe(
    true,
  );
  expect((await commands(ROOM, OTHER)).some((c) => c.reason === 'report')).toBe(false);
});

it('keeps approval resume provenance and posts progress only in the corner', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'received approval',
    kind: 'squire-approval-decided',
    wakes: [WORKER],
    requestId: turn.turnRequestId,
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'resume')!;
  expect(resumed.private).toBe(true);
  expect(resumed.source.body).toContain('received approval');
  expect(resumed.parentCommandId).toBe(turn.id);
  await claim(resumed);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(resumed), text: 'PRIVATE COORDINATION LEAK' },
    WORKER,
  );
  expect(
    (await rootFixture.db.query(`SELECT text FROM messages WHERE text='PRIVATE COORDINATION LEAK'`)).rowCount,
  ).toBe(0);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body === 'done: PRIVATE COORDINATION LEAK',
    ),
  ).toBe(false);
  expect((await commands(DM,RUBY)).some(item=>item.source.body==='PRIVATE COORDINATION LEAK')).toBe(true);
});

it('keeps private work across connection close and a new helper process resumes it without a failure report', async () => {
  const opened=await open(),turn=await worker(opened.cornerId);
  await claimAgentConnection(rootFixture.db,new LiveHub(),WORKER,{}, {connectionId:'before-disconnect',instanceId:'helper-fixture'});
  const connection=(await rootFixture.db.query<{connection_id:string}>('SELECT connection_id FROM agent_connections WHERE agent_id=$1',[WORKER])).rows[0]!;
  await releaseAgentConnection(rootFixture.db,new LiveHub(),WORKER,connection.connection_id);
  const claimed=(await rootFixture.db.query<{state:string}>('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]!;
  expect(claimed.state).toBe('pending');
  await claimAgentConnection(rootFixture.db,new LiveHub(),WORKER,{lifecycleId:'restarted-helper'},
    {connectionId:'restarted-helper',instanceId:'helper-fixture'});
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toEqual(claimed);
  expect((await commands(DM,RUBY)).some(command=>command.reason==='report'&&command.source.body.startsWith('failed:'))).toBe(false);
  const resumable=(await rootFixture.daemon.execute('getAgentCommands',{roomId:opened.cornerId},WORKER)).commands.find(command=>command.id===turn.id);
  expect(resumable?.id).toBe(turn.id);
  await startQueuedCommand(rootFixture.daemon, { roomId:opened.cornerId, commandId:turn.id }, WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toEqual(claimed);
});


it('retains workflow run and attempt guidance in private commands', async () => {
  const opened = await open();
  await systemLine(rootFixture.db, {
    id: 'specific-run-id',
    roomId: opened.cornerId,
    authorId: RUBY,
    subject: { kind: 'agent', id: RUBY, name: 'Ruby' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: 'specific-run-id',
      workflowSlug: 'specific-workflow',
      seq: 1,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const fired = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  expect(fired.source.body).toContain('specific-run-id');
  expect(fired.source.body).toContain('attempt');
  await claim(fired);
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'approved a credential',
    kind: 'squire-approval-decided',
    requestId: fired.turnRequestId,
    wakes: [WORKER],
  });
  const resumed = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'resume')!;
  expect(resumed.parentCommandId).toBe(fired.id);
  expect(fired.source.body).toContain('specific-run-id');
});

it('opens a sibling when given a corner target', async () => {
  const opened = await open();
  const nested = await rootFixture.daemon.execute(
    'createCorner',
    {
      ...authority(rootFixture.order),
      targetRoomId: opened.cornerId,
      idempotencyKey: 'nested',
      name: 'Nested',
      objective: 'Nested venue',
      brief: { spec: 'Nested work', approval: { sourceMessageId: rootFixture.order.sourceMessageId } },
    },
    RUBY,
  );
  expect(
    (await rootFixture.db.query(`SELECT parent_id FROM rooms WHERE id=$1`, [nested.cornerId])).rows[0],
  ).toMatchObject({ parent_id: ROOM });
});


it('keeps private report artifacts in the queue and forwards them with human answers', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at) VALUES($1,$2,'artifact',$3,'text/plain','report.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: report is attached' }, WORKER);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'report is attached' },
    WORKER,
  );
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await rootFixture.db.query(`SELECT room_id,card_type FROM messages WHERE attachments::text LIKE $1`, ['%' + media + '%'])).rows,
  ).toEqual([]);
  const report = (await commands(opened.cornerId, RUBY)).find((c) => c.reason === 'report')!;
  expect(report.source.attachments).toEqual([expect.objectContaining({ name: 'report.txt' })]);
  await claim(report);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(report), text: 'done: report is attached' }, RUBY);
  expect(
    (await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$2 AND attachments::text LIKE $1`, ['%' + media + '%', DM]))
      .rowCount,
  ).toBe(1);
});

it('routes zero-check completion through a durable lifecycle fact', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    head = '7'.repeat(40);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'pending', pr: { number: 21, headSha: head, mergeability: 'clean' } }),
  ]);
  const zero = new DaemonService(
    rootFixture.db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    async () =>
      ({
        checks: 'pending',
        checkCount: 0,
        zeroChecksConfirmed: true,
        headSha: head,
        approved: false,
        held: false,
        mergeAllowed: false,
      }) as any,
  );
  await zero.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Finished zero-check work' },
    WORKER,
  );
  await zero.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await rootFixture.db.query(`SELECT lifecycle->>'checks' checks FROM corner_github_cache WHERE corner_id=$1`, [opened.cornerId])).rows[0]?.checks).toBe('passing');
  expect((await rootFixture.db.query(
    "SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%zero-check pull request%'", [opened.cornerId],
  )).rowCount).toBe(0);
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'reconcile' });
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('foreign key constraint'),
    ),
  ).toBe(false);
  expect(
    (await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [turn.id])).rows[0],
  ).toMatchObject({ state: 'complete' });
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason IN ('subscribed_event','corner_review_dispatch')`,
        [opened.cornerId, RUBY],
      )
    ).rowCount,
  ).toBe(1);
});

it('a provider diagnostic leaves work pending until its failure answer is posted',async()=>{
  const opened=await open(),turn=await worker(opened.cornerId);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'failed',reason:'provider outage'},WORKER);
  expect((await commands(opened.cornerId,WORKER)).some(item=>item.id===turn.id)).toBe(true);
  expect((await commands(opened.cornerId,RUBY)).filter(item=>item.reason==='report')).toHaveLength(0);
  await rootFixture.daemon.execute('report',{...authority(turn),status:'failed',text:'The provider stopped before the work finished.'},WORKER);
  expect((await commands(opened.cornerId,WORKER)).some(item=>item.id===turn.id)).toBe(false);
  expect((await commands(opened.cornerId,RUBY)).filter(item=>item.reason==='report')).toHaveLength(1);
});


it('maintains human follows through private orders', async () => {
  const opened = await open(),
    other = 'e'.repeat(64);
  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Second Person','secondperson')`,
    [other],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, ROOM, other],
  );
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('follow-up-person',$1,$2,'@ruby update the widget')`,
    [ROOM, other],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: RUBY,
    sourceMessageId: 'follow-up-person',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: RUBY,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'order',
    { roomId: ROOM, requestId: incoming.turn_request_id, address: opened.cornerId, text: 'Update as the second person asked' },
    RUBY,
  );
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [
        opened.cornerId,
        other,
      ])
    ).rowCount,
  ).toBe(1);
});


it('resumes the incoming human order for a non-opener watch', async () => {
  const opened = await open();
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES('watch-request',$1,$2,'@worker watch the widget')`,
    [ROOM, HUMAN],
  );
  const incoming = (await createAgentCommand(rootFixture.db, {
    roomId: ROOM,
    agentId: WORKER,
    sourceMessageId: 'watch-request',
    reason: 'human_tag',
  }))!;
  await claim({
    ...incoming,
    roomId: ROOM,
    agentId: WORKER,
    id: incoming.id,
  } as unknown as AgentCommand);
  await rootFixture.daemon.execute(
    'watchCorner',
    { roomId: ROOM, cornerId: opened.cornerId, kinds: ['merged'] },
    WORKER,
  );
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: HUMAN, subject: { kind: 'system', name: 'GitHub' }, verb: 'merged', kind: 'merged' });
  const merged = (await commands(ROOM, WORKER)).find((c) => c.reason === 'watched_corner')!;
  expect(merged.parentCommandId).toBe(incoming.id);
  await claim(merged);
  await expect(
    rootFixture.daemon.execute('report', { status: 'done', ...authority(merged), text: 'done: watched corner merged' }, WORKER),
  ).resolves.toHaveProperty('id');
});


it('answers a queued workflow wake even after its run ends', async () => {
  const opened = await open(),
    run = randomBytes(32).toString('hex');
  await systemLine(rootFixture.db, {
    id: run,
    roomId: opened.cornerId,
    authorId: RUBY,
    subject: { kind: 'agent', id: RUBY, name: 'Ruby' },
    verb: 'started',
    object: 'a workflow',
    kind: 'workflow-handoff',
    presentation: 'card',
    cardType: 'workflow-handoff',
    card: {
      runId: run,
      workflowSlug: 'stale-workflow',
      seq: 0,
      toState: 'build',
      runStatus: 'live',
    },
    wakes: [WORKER],
  });
  const stale = (await commands(opened.cornerId, WORKER)).find(
    (c) => c.reason === 'subscribed_event',
  )!;
  await rootFixture.db.query(`UPDATE messages SET card=card||'{"runStatus":"done"}'::jsonb WHERE id=$1`, [run]);
  expect((await commands(opened.cornerId,WORKER)).some(item=>item.id===stale.id)).toBe(true);
  await claim(stale);
  await rootFixture.daemon.execute('postRoomMessage',{...authority(stale),text:'The workflow has already finished.'},WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[stale.id])).rows[0]).toMatchObject({state:'complete'});
});

it('retains the failure answer obligation while its return membership is gone',async()=>{
  const opened=await open(),turn=await worker(opened.cornerId);
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[DM,RUBY]);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'failed',reason:'provider outage'},WORKER);
  await expect(rootFixture.daemon.execute('report',{...authority(turn),status:'failed',text:'The provider stopped.'},WORKER)).rejects.toThrow('return address');
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toEqual({state:'pending'});
  await rootFixture.db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2',[DM,RUBY]);
  await rootFixture.daemon.execute('report',{...authority(turn),status:'failed',text:'The provider stopped.'},WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toEqual({state:'complete'});
});

it.each([false, true])('the commander revises from its DM after a check wake (cited approval: %s)', async citedApproval => {
  const opened = await open();
  const head = '9'.repeat(40);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    opened.cornerId,
    JSON.stringify({ checks: 'failing', pr: { number: 21, headSha: head } }),
  ]);
  await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'push', contents: { headSha: head } });
  await systemLine(rootFixture.db, {
    roomId: opened.cornerId,
    authorId: WORKER,
    subject: GITHUB_SUBJECT,
    verb: 'failed checks',
    kind: 'check-failed',
  });
  const check = (await commands(opened.cornerId, WORKER)).find((c) => c.reason === 'corner_check')!;
  await claim(check);
  expect(check.sourceMessageId).toBe(check.id);
  expect(check.rootSourceMessageId).toBe(rootFixture.order.rootSourceMessageId);
  const stored = (await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, RUBY)).brief!;
  await rootFixture.daemon.execute(
    'reviseCornerBrief',
    {
      ...authority(rootFixture.order),
      cornerId: opened.cornerId,
      expectedRevision: 1,
      brief: {
        spec: 'Build the widget with the necessary CI repair',
        ...(citedApproval ? { approval: { sourceMessageId: stored.approval!.sourceMessageId } } : {}),
        change: 'Repair CI',
      },
    },
    RUBY,
  );
  expect(
    (
      await rootFixture.db.query(
        `SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2`,
        [opened.cornerId],
      )
    ).rows[0],
  ).toMatchObject({
    approval_basis: citedApproval ? {
      kind: 'initiating-command',
      approvedBy: HUMAN,
      sourceMessageId: stored.approval!.sourceMessageId,
      snapshot: 'Build the widget in the target Room',
    } : {
      kind: 'commander-direct',
      approvedBy: RUBY,
      sourceMessageId: '',
      snapshot: 'Commander revised the thread brief directly',
    },
  });
});


it('discovers only reachable member addresses and corners from a DM', async () => {
  const opened = await open();
  const hidden = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Hidden')`, [hidden, WS]);
  const addresses = await rootFixture.daemon.execute('listRooms', { roomId: DM }, RUBY);
  expect(addresses.rooms).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ roomId: ROOM, name: 'Target Room' }),
      expect.objectContaining({ roomId: opened.cornerId, parentRoomId: ROOM }),
    ]),
  );
  expect(addresses.rooms.some((room) => room.roomId === hidden)).toBe(false);
  expect((await rootFixture.daemon.execute('listReachableCorners', { roomId: DM }, RUBY)).corners).toEqual([
    expect.objectContaining({ cornerId: opened.cornerId }),
  ]);
  expect((await rootFixture.daemon.execute('listRoomMembers', { roomId: ROOM }, RUBY)).members).toEqual(
    expect.arrayContaining([expect.objectContaining({ handle: 'worker' })]),
  );
});


it('keeps a file and its unanswered item pending when closing text is empty', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  const media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','legacy.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'legacy.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  );
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: '' }, WORKER);
  const returned = (await commands(DM, RUBY)).filter((c) => c.reason === 'report');
  expect(returned).toHaveLength(0);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND presentation='message'`, [
        opened.cornerId,
      ])
    ).rowCount,
  ).toBe(0);
});


it('acknowledges explicit reports so final prose does not send a second report', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('report', { status: 'done', ...authority(turn), text: 'done: widget tested' }, WORKER);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'The widget is tested' },
    WORKER,
  );
  expect((await commands(opened.cornerId, RUBY)).filter((c) => c.reason === 'report')).toHaveLength(1);
});


it('human Room reports with an agent-written mention enter the needs-you tray and push at Attention sensitivity', async () => {
  await rootFixture.db.query(`UPDATE identities SET push_level='attention' WHERE id=$1`, [HUMAN]);
  await rootFixture.db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment)
    VALUES('commander-device-token-12345678901234567890',$1,'android','physical')`,
    [HUMAN],
  );
  const send = vi.fn(async () => undefined);
  const loop = new PushDeliveryLoop(rootFixture.db, { send });
  await loop.runOnce();
  await rootFixture.phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@ruby decide the scope' },
    HUMAN,
  );
  const incoming = (await commands(ROOM, RUBY)).find((c) => c.reason === 'human_tag')!;
  await claim(incoming);
  const delivered = await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(incoming), ask: 'Which endpoint should we use?', text: 'needs-decision: choose an endpoint @captain' },
    RUBY,
  );
  expect((await rootFixture.phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
  );
  await loop.runOnce();
  expect(send.mock.calls).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ messageId: delivered.id })]),
    ]),
  );
});


it('accepts a file after a terminal report, posts it with the next message, and sends no second report', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId),
    media = randomUUID();
  await rootFixture.daemon.execute(
    'report',
    { status: 'done', ...authority(turn), text: 'done: preparing the artifact' },
    WORKER,
  );
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','late.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, WORKER, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await expect(rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...authority(turn),
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'late.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    WORKER,
  )).resolves.toBeDefined();
  await rootFixture.daemon.execute(
    'postCornerMessage',
    { ...authority(turn),cornerId:opened.cornerId, text: 'The artifact is ready' },
    WORKER,
  );
  const reports = (await commands(opened.cornerId, RUBY)).filter((c) => c.reason === 'report');
  expect(reports).toHaveLength(1);
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.messages.some(message =>
    message.attachments?.some(attachment => attachment.name === 'late.txt'))).toBe(true);
  expect(
    (
      await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`, [
        turn.turnRequestId,
      ])
    ).rowCount,
  ).toBe(0);
});


it('keeps unrelated Room subscriptions independent of completed orders', async () => {
  await rootFixture.daemon.execute(
    'order',
    { ...authority(rootFixture.order), address: ROOM, agent: WORKER, text: 'One-off Room instruction' },
    RUBY,
  );
  const prior = (await commands(ROOM, WORKER)).find((c) => c.reason === 'order')!;
  await claim(prior);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(prior), text: 'One-off complete' },
    WORKER,
  );
  await systemLine(rootFixture.db, {
    roomId: ROOM,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Captain' },
    verb: 'received',
    object: 'an unrelated Room event',
    kind: 'subscription-fired',
    wakes: [WORKER],
    subscriptionPrompt: 'POST IN THE ROOM',
    payload: { text: 'new event' },
  });
  const event = (await commands(ROOM, WORKER)).find((c) => c.reason === 'subscribed_event')!;
  await claim(event);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(event), text: 'Unrelated subscription result' },
    WORKER,
  );
  expect(event.private).not.toBe(true);
  expect(event.parentCommandId).not.toBe(prior.id);
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND text='Unrelated subscription result'`,
        [ROOM],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await commands(DM, RUBY)).some(
      (c) => c.reason === 'report' && c.source.body.includes('Unrelated subscription result'),
    ),
  ).toBe(false);
});

it('ignores retired relay metadata and answers at the recorded return address',async()=>{
  const opened=await open(),turn=await worker(opened.cornerId);
  await rootFixture.daemon.execute('postRoomMessage',{...authority(turn),text:'Old steer',
    relay:{fromRoomId:opened.cornerId,toRoomId:ROOM,direction:'down'}} as any,WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]).toEqual({state:'complete'});
  expect((await commands(DM,RUBY)).find(item=>item.reason==='reply')?.source.body).toBe('Old steer');
  expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE room_id=$1 AND text=$2',[ROOM,'Old steer'])).rowCount).toBe(0);
});
