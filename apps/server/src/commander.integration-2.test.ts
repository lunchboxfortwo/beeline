import { DM,HUMAN,ROOM,RUBY,WORKER,WS,authority,claim,commands,cornerImplementerSql,cornerOpenedFromSql,cornerTurnWithPendingChecks,createAgentCommand,duplicateReproduction,expect,insertCornerFacts,it,migrate,open,privateAssignment,quotedTagPosts,randomUUID,readCornerObjective,rootFixture,systemLine,worker,writeCornerObjective,type CommandRow } from './test-support-commander.integration.test-support.js';



it('Reproduction corner-ancestor-rule: orders reach member agents in siblings, children, ancestors and other chats', async () => {
  const opened = await open();
  const sibling = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    idempotencyKey: 'sibling', name: 'Sibling', objective: 'Build a sibling widget', implementer: 'worker',
    brief: { spec: 'Sibling widget', repositoryWork: false, approval: { sourceMessageId: rootFixture.order.sourceMessageId } },
  }, RUBY);
  const turn = await worker(opened.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'delegated-child', name: 'Child', objective: 'Build a child widget', implementer: 'ruby',
    brief: { spec: 'Child widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  const otherRoom = randomUUID(), otherCorner = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Other Room',$3)`, [otherRoom, WS, HUMAN]);
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Other corner',$4)`,
    [otherCorner, WS, otherRoom, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WS, otherRoom, WORKER]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$4,'member'),($1,$3,$5,'member')`, [WS, otherRoom, DM, RUBY, WORKER]);
  await insertCornerFacts(rootFixture.db, { cornerId: otherCorner, ownerAgentId: RUBY });
  await rootFixture.daemon.execute('order', { ...authority(turn), address: sibling.cornerId, agent: 'ruby', text: 'Review sibling' }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: otherCorner, text: 'Review other corner' }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: otherRoom, agent: 'ruby', text: 'Review in other Room' }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: DM, text: 'Review through DM' }, WORKER);
  for (const address of [RUBY, 'ruby', '@ruby'])
    await expect(rootFixture.daemon.execute('order', { ...authority(turn), address, text: 'Invalid address' }, WORKER)).rejects.toMatchObject({kind:'membership'});
  await rootFixture.daemon.execute('order', { ...authority(turn), address: otherRoom, text: 'Resolve the sole other agent' }, WORKER);
  await expect(rootFixture.daemon.execute('order', { ...authority(turn), address: randomUUID(), text: 'No membership' }, WORKER))
    .rejects.toThrow('address requires current membership');
  expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: child.cornerId }, WORKER)).openedFromCornerId)
    .toBe(opened.cornerId);
  expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: sibling.cornerId }, WORKER)).openedFromCornerId)
    .toBeUndefined();
  for (const address of [ROOM, ROOM.toUpperCase()])
    await rootFixture.daemon.execute('order', { ...authority(turn), address, text: 'Do the review' }, WORKER);
  for (const address of [child.cornerId, opened.cornerId]) {
    await rootFixture.daemon.execute('order', { ...authority(turn), address, agent: 'ruby', text: 'Review this widget' }, WORKER);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND reason='order'`, [address])).rowCount).toBe(1);
  }
  const childTurn = (await commands(child.cornerId, RUBY)).find(c => c.reason === 'order')!;
  await claim(childTurn);
  const grandchild = await rootFixture.daemon.execute('createCorner', { ...authority(childTurn), targetRoomId: ROOM,
    idempotencyKey: 'grandchild', name: 'Grandchild', objective: 'Build the grandchild widget', implementer: 'worker',
    brief: { spec: 'Grandchild widget', repositoryWork: false, approval: { sourceMessageId: childTurn.sourceMessageId } },
  }, RUBY);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: grandchild.cornerId, agent: 'ruby', text: 'Coordinate this widget' }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(childTurn), address: grandchild.cornerId, text: 'Work in the grandchild' }, RUBY);
  for (const address of [opened.cornerId]) {
    await rootFixture.daemon.execute('order', { ...authority(childTurn), address, text: 'Order ancestor' }, RUBY);
  }
  const grandchildTurn = (await commands(grandchild.cornerId, WORKER))[0]!;
  await claim(grandchildTurn);
  for (const address of [child.cornerId, opened.cornerId]) {
    await rootFixture.daemon.execute('order', { ...authority(grandchildTurn), address, text: 'Order ancestor' }, WORKER);
  }
  for (const cornerId of [child.cornerId, opened.cornerId]) {
    await expect(rootFixture.daemon.execute('reviseCornerBrief', { ...authority(grandchildTurn), cornerId, expectedRevision: 1,
      brief: { spec: 'Ancestor work', change: 'Attempt', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER))
      .rejects.toThrow("Threads can't order their parent chat. Report to your commander instead.");
  }
  console.log('[corner-ancestor-rule] sibling/self/child/parent Room orders delivered; all member chat addresses delivered; identity addresses and nonmembers refused');
  await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: grandchild.cornerId, expectedRevision: 1,
    brief: { spec: 'Clarified grandchild widget', change: 'Clarify', repositoryWork: false,
      approval: { sourceMessageId: grandchildTurn.sourceMessageId } } }, WORKER);
  await rootFixture.daemon.execute('archiveCorner', { ...authority(turn), cornerId: grandchild.cornerId }, WORKER);
  // Closing is cleanup rather than an order: even the ended grandchild turn
  // can close an ancestor through the same current parent Room membership.
  await rootFixture.daemon.execute('archiveCorner', { ...authority(grandchildTurn), cornerId: opened.cornerId }, WORKER);
  expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [opened.cornerId])).rows[0])
    .toEqual({ archived: true });

});

it('issues-triage can order and revise fix threads but cannot open in an inaccessible DM', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE rooms SET name='issues-triage' WHERE id=$1`, [opened.cornerId]);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'triage-fix', name: 'Fix', objective: 'Fix the assigned widget', implementer: 'ruby',
    brief: { spec: 'Fix the widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: child.cornerId, text: 'Fix the widget' }, WORKER);
  const revised = await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: child.cornerId,
    expectedRevision: 1, brief: { spec: 'Fix the widget with clarified criteria', repositoryWork: false,
      change: 'Clarify criteria' } }, WORKER);
  expect(revised.revision).toBe(2);
  await rootFixture.daemon.execute('archiveCorner', { ...authority(turn), cornerId: child.cornerId }, WORKER);
  expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [child.cornerId])).rows[0]).toEqual({ archived: true });
  await expect(rootFixture.daemon.execute('createCorner', { ...authority(turn), targetRoomId: DM,
    idempotencyKey: 'escape', name: 'Escape', objective: 'Recruit outside the Room',
    brief: { spec: 'Escape', approval: { sourceMessageId: turn.sourceMessageId } } }, WORKER))
    .rejects.toThrow('daemon chat access denied');
});

it('corner message wakes an instance in the same corner while a tag stays quiet', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const tag = await rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId:opened.cornerId, text: '@ruby review this here' }, WORKER);
  expect(tag.woken).toEqual([]);
  expect(await commands(opened.cornerId, RUBY)).toEqual([]);
  await rootFixture.daemon.execute('message', { ...authority(turn), to:{agent:RUBY,place:opened.cornerId}, text:'review this here' }, WORKER);
  expect((await commands(opened.cornerId, RUBY)).map(item=>item.reason)).toEqual(['message']);
  expect((await commands(ROOM, RUBY))).toEqual([]);
});


it('corner revisions and closes accept self and sibling corners', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const sibling = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    idempotencyKey: 'legacy', name: 'Legacy', objective: 'Build a legacy widget', implementer: 'worker',
    brief: { spec: 'Legacy widget', repositoryWork: false, approval: { sourceMessageId: rootFixture.order.sourceMessageId } },
  }, RUBY);
  for (const cornerId of [opened.cornerId, sibling.cornerId]) {
    const brief = (await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, WORKER)).brief!;
    await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId, expectedRevision: 1,
      brief: { spec: 'Clarified work', change: 'Clarify', repositoryWork: false, approval: { sourceMessageId: brief.approval!.sourceMessageId } } }, WORKER);
  }
  for (const cornerId of [sibling.cornerId, opened.cornerId]) {
    await rootFixture.daemon.execute('archiveCorner', { ...authority(turn), cornerId }, WORKER);
    expect((await rootFixture.db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [cornerId])).rows[0]).toEqual({ archived: true });
  }
});


it('migration leaves legacy opening provenance empty and preserves new provenance', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const child = await rootFixture.daemon.execute('createCorner', { ...authority(turn), targetRoomId: ROOM,
    idempotencyKey: 'migration-child', name: 'Child', objective: 'Build a child widget',
    brief: { spec: 'Child widget', repositoryWork: false, approval: { sourceMessageId: turn.sourceMessageId } },
  }, WORKER);
  await migrate(rootFixture.db);
  expect((await rootFixture.db.query(`SELECT ${cornerOpenedFromSql('corner_id')} opened_from_corner_id FROM corner_facts WHERE corner_id=$1`, [opened.cornerId])).rows[0])
    .toEqual({ opened_from_corner_id: null });
  expect((await rootFixture.db.query(`SELECT ${cornerOpenedFromSql('corner_id')} opened_from_corner_id FROM corner_facts WHERE corner_id=$1`, [child.cornerId])).rows[0])
    .toEqual({ opened_from_corner_id: opened.cornerId });
});


it.each(['primary reviewer', 'commander'])('Reproduction reviewer-handback-2471: %s orders its corner worker', async (role) => {
  const opened = await open();
  if (role !== 'commander') {
    await rootFixture.db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [opened.cornerId, WORKER]);
    await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($2::text)) WHERE room_id=$1`, [opened.cornerId, WORKER]);
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM, RUBY]);
  }
  const queued = await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: RUBY,
    sourceMessageId: null, reason: 'corner_review_dispatch',
    privatePayload: { text: 'Review the widget', authorId: HUMAN, fromRoomId: ROOM, kind: 'order' } });
  const turn = (await commands(opened.cornerId, RUBY)).find(c => c.id === queued!.id)!;
  await claim(turn);
  await rootFixture.daemon.execute('order', { ...authority(turn), address: opened.cornerId, text: 'FAIL: repair the widget' }, RUBY);
  expect((await commands(opened.cornerId, WORKER)).find(c => c.reason === 'order'))
    .toMatchObject({ private: true, source: { authorId: RUBY, body: 'FAIL: repair the widget' } });
  console.log(`[reviewer-handback-2471] ${role} → own corner worker: repair order delivered privately`);
});


it('keeps Room opening facts historical while current worker and commander goals update', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE rooms SET about='Legacy version 1.1.17 goal' WHERE id=$1`, [opened.cornerId]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
    VALUES('goal-card',$1,$2,'Opened','daemon-fact',$3::jsonb)`,
    [ROOM, RUBY, JSON.stringify({ type: 'corner-open', cornerId: opened.cornerId, name: 'Widget', objective: 'Build the widget', sourceMessageId: 'source' })]);
  // Model a historical parent record explicitly; new DM opens no longer write it.
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card,created_at)
    VALUES('legacy-opening',$1,$2,'Opened','daemon-fact',$3::jsonb,now()-interval '1 minute')`,
    [ROOM,RUBY,JSON.stringify({type:'corner-open',cornerId:opened.cornerId,name:'Widget',objective:'Widget'})]);
  const stored = (await rootFixture.db.query(`SELECT * FROM messages ORDER BY id`)).rows;
  const openingId = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1
    AND card->>'cornerId'=$2 AND id<>'goal-card' AND card->>'type'='corner-open' LIMIT 1`,
    [ROOM, opened.cornerId])).rows[0]!.id;
  for (const [actor, command, objective] of [
    [WORKER, turn, 'Ship version 1.1.18'], [RUBY, rootFixture.order, 'Ship version 1.1.19'],
  ] as const) {
    const name = actor === WORKER ? 'Current-widget' : 'Next-widget';
    await rootFixture.daemon.execute('renameCorner', { ...authority(command), cornerId: opened.cornerId,
      name, objective }, actor);
    expect(await readCornerObjective(rootFixture.db, opened.cornerId)).toBe(objective);
    expect((await rootFixture.db.query(`SELECT * FROM messages ORDER BY id`)).rows).toEqual(stored);
    const currentCard = { type: 'corner-open', cornerId: opened.cornerId, name: 'Widget', objective: 'Widget' };
    for (const page of [
      await rootFixture.phone.readRoom(ROOM, HUMAN),
      await rootFixture.phone.readHistory(ROOM, HUMAN),
      await rootFixture.phone.readHistoryAround(ROOM, HUMAN, 'goal-card'),
      await rootFixture.phone.readHistoryAfter(ROOM, HUMAN, openingId),
    ]) expect(page?.messages.find(message => message.id === 'goal-card')?.daemonFact).toMatchObject(currentCard);
    const live = await rootFixture.phone.readLiveDelta(ROOM, HUMAN, { type: 'message', messageId: 'goal-card' });
    expect(live?.type === 'message-delta' ? live.message.daemonFact : undefined).toMatchObject(currentCard);
    expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.room.about).toBe(objective);
    expect((await rootFixture.phone.readCorners(ROOM, HUMAN))?.corners)
      .toContainEqual(expect.objectContaining({ corner: expect.objectContaining({ id: opened.cornerId, about: objective }) }));
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId: opened.cornerId }, actor)).objective)
      .toBe(objective);
    expect((await rootFixture.daemon.execute('listRoomCorners', { roomId: ROOM }, actor)).corners)
      .toContainEqual(expect.objectContaining({ cornerId: opened.cornerId, objective }));
    expect((await rootFixture.db.query(`SELECT * FROM messages ORDER BY id`)).rows).toEqual(stored);
  }
});


it('records background completion in its original invocation without a bookkeeping turn', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [turn.id]);
  const completion = { ...authority(turn), toolCallId: 'build-1', title: 'npm test', status: 'completed' as const };
  await rootFixture.daemon.execute('postBackgroundToolCompletion', completion, WORKER);
  await rootFixture.daemon.execute('postBackgroundToolCompletion', completion, WORKER);
  const wakes = (await commands(opened.cornerId, WORKER)).filter(c => c.reason === 'corner_background_tool');
  expect(wakes).toEqual([]);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows[0]?.state).toBe('complete');
  await rootFixture.daemon.execute('postBackgroundToolCompletion', { ...completion }, WORKER);
  await expect(rootFixture.daemon.execute('postBackgroundToolCompletion', completion, RUBY)).rejects.toThrow();
  await rootFixture.db.query(`UPDATE agent_commands SET state='cancelled' WHERE id=$1`, [turn.id]);
  await expect(rootFixture.daemon.execute('postBackgroundToolCompletion', { ...completion, toolCallId: 'other' }, WORKER))
    .rejects.toThrow('command turn cancelled');
});


it('makes an owner-approved systemctl user-bus command available in a subsequent corner turn', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const target = 'env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user';
  await rootFixture.db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,decided_by)
    VALUES('10000000-0000-4000-8000-000000000099',$1,$2,$3,'command',$4,'Manage user service',$5,'approved',$6)`,
    [WORKER, WS, ROOM, target, RUBY, HUMAN]);
  expect((await rootFixture.daemon.execute('listTurnAgentGrants', authority(turn), WORKER)).grants)
    .toContainEqual(expect.objectContaining({ target }));
});


it('does not resolve an opening card against a corner belonging to another parent Room', async () => {
  const opened = await open();
  // A resident call-site marker must not resolve another Room's private goal.
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
    VALUES('resident-opening',$1,$2,'Opened','daemon-fact',$3::jsonb)`,
    [ROOM,RUBY,JSON.stringify({type:'corner-open',cornerId:opened.cornerId,name:'Widget',objective:'Widget',sourceMessageId:'source'})]);
  await rootFixture.db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [opened.cornerId, DM]);
  await writeCornerObjective(rootFixture.db, opened.cornerId, 'Private goal in another Room');
  const view = await rootFixture.phone.readRoom(ROOM, HUMAN);
  expect(view?.messages.find(message => message.daemonFact?.cornerId === opened.cornerId)?.daemonFact)
    .toMatchObject({ name: 'Widget', objective: 'Widget' });
});


it('the same corner can order and report privately to its parent Room commander', async () => {
  const parentCommand = await createAgentCommand(rootFixture.db, { roomId: ROOM, agentId: RUBY,
    sourceMessageId: null, reason: 'order', privatePayload: { text: 'Coordinate this task', authorId: WORKER, fromRoomId: DM, kind: 'order' } });
  const parent = (await commands(ROOM, RUBY)).find(command => command.id === parentCommand!.id)!;
  await claim(parent);
  const opened = await rootFixture.daemon.execute('createCorner', { ...authority(parent), targetRoomId: ROOM,
    name: 'Proof', objective: 'Prove report routing', implementer: 'worker',
    brief: { spec: 'Deliver proof', repositoryWork: false, approval: { sourceMessageId: parent.id } } }, RUBY);
  const child = await worker(opened.cornerId);
  await rootFixture.daemon.execute('order', { ...authority(child), address: ROOM, agent: RUBY, text: 'Recruit parent' }, WORKER);
  await rootFixture.daemon.execute('report', { ...authority(child), status: 'blocked', text: 'blocked: need the commander decision' }, WORKER);
  expect((await commands(opened.cornerId, RUBY)).find(command => command.reason === 'report'))
    .toMatchObject({ private: true, source: { authorId: WORKER, body: 'blocked: need the commander decision' } });
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text=$1`, ['blocked: need the commander decision'])).rowCount).toBe(0);
});


it('public corner notes stay durable without waking a worker or commander', async () => {
  const opened = await open();
  const before = (await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: opened.cornerId, text: 'A public note without work authority' }, RUBY);
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text=$2`, [opened.cornerId, 'A public note without work authority'])).rowCount).toBe(1);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
});


it('lists only the caller’s own lifecycle watches at the current address', async () => {
  const opened = await open();
  await rootFixture.db.query(`INSERT INTO corner_watches(watcher_room_id,agent_id,corner_id,kinds) VALUES($1,$2,$3,'["merged"]'::jsonb)`, [DM, WORKER, opened.cornerId]);
  expect(await rootFixture.daemon.execute('listAgentWatches', { roomId: DM }, RUBY)).toEqual({ watches: [{ address: opened.cornerId, kinds: ['opened', 'merged'] }] });
});


it('compact schedule operations manage only self-owned sources', async () => {
  const mine = await rootFixture.daemon.execute('createAgentSchedule', { title: 'Scheduled check', ...authority(rootFixture.order), agentId: RUBY,
    prompt: 'Inspect my pending work', cadence: { kind: 'interval', everyMinutes: 5 } }, RUBY) as { scheduleId: string };
  const otherId = randomUUID();
  await rootFixture.db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":5}'::jsonb,'Other agent work',now())`, [otherId, WS, DM, WORKER]);
  for (const action of ['update', 'delete'] as const) {
    await expect(rootFixture.daemon.execute(action === 'update' ? 'updateAgentSchedule' : 'deleteAgentSchedule', { ...authority(rootFixture.order), agentId: RUBY, selfOnly: true, scheduleId: otherId, prompt: 'Forged' }, RUBY))
      .rejects.toThrow('schedule not found');
  }
  const listed = await rootFixture.daemon.execute('listAgentSchedules', { ...authority(rootFixture.order), agentId: RUBY, selfOnly: true }, RUBY) as { schedules: { scheduleId: string }[] };
  expect(listed.schedules.map(schedule => schedule.scheduleId)).toEqual([mine.scheduleId]);
  const before = (await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows;
  await rootFixture.daemon.execute('updateAgentSchedule', { ...authority(rootFixture.order), agentId: RUBY, selfOnly: true, scheduleId: mine.scheduleId, prompt: 'Updated self work' }, RUBY);
  await rootFixture.daemon.execute('deleteAgentSchedule', { ...authority(rootFixture.order), agentId: RUBY, selfOnly: true, scheduleId: mine.scheduleId }, RUBY);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual(before);
  expect((await rootFixture.db.query(`SELECT message FROM agent_schedules WHERE id=$1`, [otherId])).rows[0]).toEqual({ message: 'Other agent work' });
});


it('vocabulary: commander orders the child reviewer and its report returns privately', async () => {
  const reviewer = '6'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Speedy','speedy') ON CONFLICT DO NOTHING`, [reviewer]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [reviewer,HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WS,reviewer,ROOM]);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [ROOM,reviewer]);
  const opened = await open();
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address:opened.cornerId, agent:'speedy', text:'Review the exact head' }, RUBY);
  const review = (await commands(opened.cornerId,reviewer)).find(command => command.reason === 'order')!;
  expect(review).toMatchObject({private:true,source:{body:'Review the exact head'}});
  await claim(review);
  await rootFixture.daemon.execute('report', { ...authority(review), status:'blocked', text:'blocked: waiting for green checks' }, reviewer);
  expect((await commands(opened.cornerId, RUBY)).find(command => command.reason === 'report')?.source.body).toBe('blocked: waiting for green checks');
  expect((await rootFixture.db.query(`SELECT ${cornerImplementerSql('f', 'c')} worker_agent_id FROM corner_facts f JOIN rooms c ON c.id=f.corner_id WHERE f.corner_id=$1`,[opened.cornerId])).rows[0]?.worker_agent_id).not.toBe(reviewer);
});


it('vocabulary: corner message starts conversation in the addressed place without an assignment', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId:opened.cornerId, text:'@ruby discuss the wording; @absent can you join?' }, WORKER);
  expect(posted.woken).toEqual([]);
  expect(posted.notWoken).toContainEqual({handle:'absent',reason:expect.stringContaining('member')});
  expect(await commands(opened.cornerId,RUBY)).toEqual([]);
  await rootFixture.daemon.execute('message',{...authority(turn),to:{agent:RUBY,place:opened.cornerId},text:'discuss the wording'},WORKER);
  const reply = (await commands(opened.cornerId,RUBY)).find(command => command.reason === 'message')!;
  expect(reply.from).toEqual({agent:WORKER,place:opened.cornerId});
  await claim(reply);
  await rootFixture.daemon.execute('postRoomMessage', {...authority(reply),text:'Here is my wording suggestion.'},RUBY);
  expect((await commands(opened.cornerId,WORKER)).find(item=>item.source.body==='Here is my wording suggestion.')).toMatchObject({reason:'reply',from:{agent:RUBY,place:opened.cornerId}});
  expect((await commands(DM,RUBY)).some(command => command.reason === 'report')).toBe(false);
});


it('vocabulary: forbidden thread orders give a usable report step', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(rootFixture.daemon.execute('order', {...authority(turn),address:DM,agent:'ruby',text:'Do parent work'},WORKER)).rejects.toThrow('address requires current membership');
  await rootFixture.daemon.execute('report', {...authority(turn),status:'blocked',text:'blocked: parent work needs the commander'},WORKER);
  expect((await commands(opened.cornerId, RUBY)).find(command => command.reason === 'report')?.source.body).toContain('parent work');
});


it('public-note tags stay quiet at depth while messages retain provenance', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE agent_commands SET agent_depth=3 WHERE id=$1`,[turn.id]);
  const posted = await rootFixture.daemon.execute('postCornerMessage', {...authority(turn),cornerId:opened.cornerId,text:'@ruby discuss this at the depth bound'},WORKER);
  expect(posted.woken).toEqual([]);
  expect(posted.notWoken).toEqual([]);
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE id=$1`,[posted.id])).rows[0]?.text).toContain('@ruby');
  expect(await commands(opened.cornerId,RUBY)).toEqual([]);
  const message=await rootFixture.daemon.execute('message',{...authority(turn),to:{agent:RUBY,place:opened.cornerId},text:'discuss this at the depth bound'},WORKER);
  expect((await rootFixture.db.query('SELECT agent_depth,parent_command_id FROM agent_commands WHERE id=$1',[message.id])).rows[0])
    .toEqual({agent_depth:4,parent_command_id:turn.id});
});


it('vocabulary: a configured reviewer outside the parent Room cannot be ordered', async () => {
  const reviewer = '6'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Speedy','speedy') ON CONFLICT DO NOTHING`,[reviewer]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[reviewer,HUMAN]);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`,[ROOM,reviewer]);
  const opened = await open(), turn = await worker(opened.cornerId);
  await expect(rootFixture.daemon.execute('order', {...authority(turn),address:opened.cornerId,agent:'speedy',text:'Review this'},WORKER)).rejects.toMatchObject({kind:'membership'});
});

it.each(['empty', 'no-reply'])('an early diagnostic leaves an unanswered Room order queued (%s)', async kind => {
  const { turn } = await privateAssignment();
  const input = { ...authority(turn), agentId: WORKER, status: 'complete' as const,
    ...(kind === 'no-reply' ? { completionKind: 'no-reply' as const } : {}), toolCalls: kind === 'empty' ? 0 : 1 };
  const before = (await rootFixture.db.query('SELECT id FROM messages ORDER BY id')).rows;
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...input }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...input }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  expect((await rootFixture.db.query('SELECT id FROM messages ORDER BY id')).rows).toEqual(before);
  expect((await rootFixture.db.query('SELECT status,failure_reason FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [turn.turnRequestId, WORKER])).rows[0])
    .toMatchObject({ status: 'working', failure_reason: null });
  expect((await commands(ROOM,WORKER)).map(command=>command.id)).toContain(turn.id);
});

it.each(['harness exit','provider unavailable','login required'])('an actual answer about %s reaches its recorded return address',async reason=>{
  const {turn}=await privateAssignment();const text='Worker stopped while answering this: '+reason;
  await rootFixture.daemon.execute('postRoomMessage',{...authority(turn),text},WORKER);
  const reports=(await commands(DM,RUBY)).filter(command=>command.reason==='report');
  expect(reports).toHaveLength(1);expect(reports[0]!.source.body).toBe(text);
  await claim(reports[0]!);
  await rootFixture.daemon.execute('report',{...authority(reports[0]!),status:'failed',text},RUBY);
  expect((await rootFixture.phone.readRoom(DM,HUMAN))?.messages.filter(message=>message.text==='failed: '+text)).toHaveLength(1);
});

it.each(['explicit', 'implicit'])('failure visibility: %s delivered report suppresses missing-outcome fallback', async kind => {
  const { turn } = await privateAssignment();
  if (kind === 'explicit') {
    await rootFixture.daemon.execute('report', { ...authority(turn), status: 'blocked', text: 'blocked: need a login decision' }, WORKER);
    await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'A decision is still needed.' }, WORKER);
  }
  else await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'The saved login needs a decision.' }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1', [turn.turnRequestId])).rows[0]?.status).toBe('complete');
});

it.each(['complete', 'failed'] as const)('failure visibility: a recorded child order permits quiet waiting after %s stop', async status => {
  const { turn } = await privateAssignment();
  await rootFixture.daemon.execute('order', { ...authority(turn), address: ROOM, agent: RUBY, text: 'Check the saved login prerequisites' }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status,
    ...(status === 'failed' ? { reason: 'unreported_order: repeated-tool-call; requested work is unconfirmed' } : {}) }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});

it('failure visibility: a recorded pending grant permits quiet waiting', async () => {
  const { turn } = await privateAssignment();
  const grant = randomUUID();
  await rootFixture.db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,command_id)
    VALUES($1,$2,$3,'host','example.com','Needed for assigned work',$2,$4,'pending',$5)`, [grant, WORKER, WS, ROOM, turn.id]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});

it('late diagnostics cannot revive a stopped item or manufacture an answer',async()=>{
  const {turn}=await privateAssignment();
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'complete'},WORKER);
  expect((await commands(ROOM,WORKER)).map(command=>command.id)).toContain(turn.id);
  await rootFixture.db.query("UPDATE agent_commands SET state='cancelled' WHERE id=$1",[turn.id]);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'complete'},WORKER);
  expect((await commands(DM,RUBY)).filter(command=>command.reason==='report')).toEqual([]);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[turn.id])).rows).toEqual([{state:'cancelled'}]);
});

it('closed-corner reports do not fall back through a recorded opening ancestor', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)) WHERE id=$1`, [turn.id, opened.cornerId]);
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [opened.cornerId]);
  // Exercise routing itself: archived execution has no permission to write tools.
  const { reportToCommander } = await import('./commander.js');
  const command = (await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [turn.id])).rows[0]!;
  await expect(reportToCommander(rootFixture.db, opened.cornerId, WORKER, 'failed: saved login is unconfirmed', command, 'archived-report')).rejects.toMatchObject({ kind: 'stop' });
  expect((await commands(ROOM, RUBY)).find(c => c.id === 'archived-report')).toBeUndefined();
  expect((await commands(opened.cornerId, RUBY)).some(c => c.id === 'archived-report')).toBe(false);
});

it('failure visibility: unavailable commander membership refuses automatic publication without committing success', async () => {
  const { turn } = await privateAssignment();
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await expect(rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'The login needs attention' }, WORKER)).rejects.toThrow('return address');
  expect((await rootFixture.db.query('SELECT state,private_payload FROM agent_commands WHERE id=$1', [turn.id])).rows[0])
    .toMatchObject({ state: 'pending', private_payload: expect.not.objectContaining({ reportedGenerationId: expect.anything() }) });
});

it('failure visibility: dispatch receipt confirms only private queue acceptance', async () => {
  const { receipt } = await privateAssignment();
  expect(receipt).toMatchObject({ accepted: true, executionConfirmed: false, receipt: expect.stringContaining('queued privately') });
});

it('terminal completion reflects an actual failed report rather than an early diagnostic',async()=>{
  const {turn}=await privateAssignment();
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'failed',reason:'provider unavailable'},WORKER);
  expect(await rootFixture.daemon.execute('getRequestCompletion',{roomId:ROOM,requestId:turn.turnRequestId},WORKER)).toMatchObject({completed:false});
  await rootFixture.daemon.execute('report',{...authority(turn),status:'failed',text:'The provider is unavailable.'},WORKER);
  expect(await rootFixture.daemon.execute('getRequestCompletion',{roomId:ROOM,requestId:turn.turnRequestId},WORKER)).toMatchObject({completed:true,outcome:'failed'});
});

it('failure visibility: restored commander membership permits one automatic report after a refused publication', async () => {
  const { turn } = await privateAssignment();
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await expect(rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER)).rejects.toThrow('return address');
  await rootFixture.db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [DM, RUBY]);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: login needs attention' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
});



it('closed-corner reports do not wake even the nearest live opening ancestor', async () => {
  const opened = await open(), turn = await worker(opened.cornerId), ancestor = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Live parent corner',$4)`, [ancestor, WS, ROOM, RUBY]);
  await insertCornerFacts(rootFixture.db, { cornerId: ancestor, ownerAgentId: RUBY, lifecycle: '{"lifecycle":"implement"}' });
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)) WHERE room_id=$1 AND reason='corner_objective'`, [opened.cornerId, ancestor]);
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)) WHERE id=$1`, [turn.id, opened.cornerId]);
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [opened.cornerId]);
  const { reportToCommander } = await import('./commander.js');
  const command = (await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [turn.id])).rows[0]!;
  await expect(reportToCommander(rootFixture.db, opened.cornerId, WORKER, 'failed: login is unconfirmed', command, 'nearest-live-report')).rejects.toMatchObject({ kind: 'stop' });
  expect((await commands(ancestor, RUBY)).find(c => c.id === 'nearest-live-report')).toBeUndefined();
  expect((await commands(ROOM, RUBY)).find(c => c.id === 'nearest-live-report')).toBeUndefined();
});

it('failure visibility: Squire approval proves a current durable wait, not a completed outcome', async () => {
  const { turn } = await privateAssignment();
  await rootFixture.daemon.execute('postSquireApproval', {action: 'Use the requested resource', purpose: 'complete the requested task',  ...authority(turn), tool: 'operate_login', title: 'Saved login approval',
    detail: 'Approve the saved login', approvalUrl: 'https://example.com/approval', approvalId: 'login-approval', linkKind: 'approval' }, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});

it('failure visibility: post acknowledges stored visible text and cannot discharge an order', async () => {
  const opened = await open();
  const result = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: opened.cornerId, text: 'Work remains to be done' }, RUBY);
  expect(result).toMatchObject({ stored: true, visible: true, receipt: 'Message stored and visible. No agents woken.' });
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(0);
});

it('Reproduction 13: a public final reply closes its private assignment without inventing a commander report', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'I checked the login page.' }, WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1', [turn.id])).rows[0]?.state).toBe('complete');
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
});


// These drive the public daemon receipt and report operations with durable provenance.
it.each([true, false])('Reproduction R1/R2: lifecycle receipt preserves delivered outcome=%s', async delivered => {
  const opened = await open();
  const initial = await worker(opened.cornerId);
  const parent = (await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [initial.id])).rows[0]!;
  await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER,
    sourceMessageId: null, reason: 'watched_corner', parent,
    privatePayload: { kind: 'lifecycle', text: 'Watched corner merged',
      authorId: RUBY, fromRoomId: opened.cornerId } });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'watched_corner')!;
  await claim(wake);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: WORKER, status: 'working' }, WORKER);
  if (delivered) {
    const receipt = await rootFixture.daemon.execute('report', { ...authority(wake), status: 'needs_decision',
      text: 'needs-decision: choose the next step' }, WORKER);
    expect(receipt).toMatchObject({ delivered: true });
  }
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: WORKER,
    status: 'failed', reason: 'unreported_order: requested work is unconfirmed' }, WORKER);
  const reports = (await commands(opened.cornerId, RUBY)).filter(c => c.reason === 'report');
  expect(reports).toHaveLength(delivered ? 1 : 0);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1', [wake.turnRequestId])).rows[0]?.status).toBe(delivered?'complete':'working');
});


it.each(['no-reply', 'legacy-failure'])('a merge watch keeps its answer obligation despite a %s diagnostic', async mode => {
  const opened = await open();
  await systemLine(rootFixture.db, { roomId: opened.cornerId, authorId: HUMAN,
    subject: { kind: 'system', name: 'GitHub' }, verb: 'merged', kind: 'merged' });
  const wake = (await commands(DM, RUBY)).find(c => c.reason === 'watched_corner')!;
  expect(wake).toBeDefined();
  await claim(wake);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: RUBY, status: 'working' }, RUBY);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(wake), agentId: RUBY,
    ...(mode === 'no-reply' ? { status: 'complete' as const, completionKind: 'no-reply' as const }
      : { status: 'failed' as const, reason: 'unreported_order: requested work is unconfirmed' }) }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))?.messages.filter(m => m.text.startsWith('failed:'))).toHaveLength(0);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1', [wake.turnRequestId])).rows[0]?.status).toBe('working');
  await rootFixture.daemon.execute('postRoomMessage',{...authority(wake),text:'The watched corner merged.'},RUBY);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[wake.id])).rows).toEqual([{state:'complete'}]);
});


it.each(['complete', 'failed'] as const)('Reproduction R1: delivered needs-decision on an order survives %s receipt', async status => {
  const { turn } = await privateAssignment();
  expect(await rootFixture.daemon.execute('report', { ...authority(turn), status: 'needs_decision',
    text: 'needs-decision: choose the next step' }, WORKER)).toMatchObject({ delivered: true });
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status,
    ...(status === 'failed' ? { reason: 'unreported_order: requested work is unconfirmed' } : {}) }, WORKER);
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toHaveLength(1);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1', [turn.turnRequestId])).rows[0]?.status).toBe('complete');
});

it('Reproduction unreported-order-false: an unreported corner turn with pending checks sends nothing', async () => {
  const { opened, turn, lifecycle } = await cornerTurnWithPendingChecks();
  expect((await commands(DM, RUBY)).filter(c => c.reason === 'report')).toEqual([]);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1 AND agent_id=$2', [turn.turnRequestId, WORKER])).rows[0]?.status).toBe('working');
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='turn-failed'`, [opened.cornerId])).rowCount).toBe(0);
  expect((await rootFixture.db.query('SELECT private_payload FROM agent_commands WHERE id=$1', [turn.id])).rows[0]?.private_payload)
    .not.toHaveProperty('reportedGenerationId');
  expect((await rootFixture.db.query('SELECT lifecycle FROM corner_facts WHERE corner_id=$1', [opened.cornerId])).rows[0]?.lifecycle)
    .toMatchObject(lifecycle);
  console.info('Demonstrated Reproduction unreported-order-false: pending-checks corner turn ended unreported; commander reports=0; order open; corner in-review');
});

it('Reproduction unreported-order-false: a later report(done) closes the open order as before', async () => {
  const { opened } = await cornerTurnWithPendingChecks();
  await createAgentCommand(rootFixture.db, { roomId: opened.cornerId, agentId: WORKER, sourceMessageId: null, reason: 'corner_check' });
  const wake = (await commands(opened.cornerId, WORKER)).find(c => c.reason === 'corner_check')!;
  await claim(wake);
  await expect(rootFixture.daemon.execute('report', { ...authority(wake), status: 'done', text: 'done: checks passed' }, WORKER))
    .resolves.toMatchObject({ delivered: true });
  expect((await commands(opened.cornerId, RUBY)).filter(c => c.reason === 'report').map(c => c.source.body)).toEqual(['done: checks passed']);
  console.info('Demonstrated Reproduction unreported-order-false: later report(done) delivered once to the commander');
});



it('R1: a member posts a public message to a top-level Room', async () => {
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: ROOM, text: 'Room posting proof' }, RUBY);
  expect(posted).toMatchObject({ address: ROOM, stored: true, visible: true, receipt: 'Message stored and visible. No agents woken.' });
  expect((await rootFixture.phone.readRoom(ROOM, HUMAN))?.messages.some(message => message.id === posted.id && message.text === 'Room posting proof')).toBe(true);
});


it('R1: post refuses removed membership, archived and unknown addresses clearly', async () => {
  const unknown = randomUUID();
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: unknown, text: 'Refused' }, RUBY)).rejects.toMatchObject({kind:'membership'});
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: 'bad-address', text: 'Refused' }, RUBY)).rejects.toMatchObject({kind:'membership'});
  await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [ROOM]);
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: ROOM, text: 'Refused' }, RUBY)).rejects.toThrow('address is archived');
  await rootFixture.db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [ROOM]);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
  await expect(rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: ROOM, text: 'Refused' }, RUBY)).rejects.toThrow('address requires current membership');
  expect((await rootFixture.db.query(`SELECT id FROM messages WHERE text='Refused'`)).rowCount).toBe(0);
});



it('Reproduction R1: each agent post receipt truthfully reports no wake', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  const post = (text: string) => rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER);
  const first = await post('@ruby discuss this');
  expect(first.woken).toEqual([]);
  expect(first.receipt).toContain('No agents woken.');
  const other = '7'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [other]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [other,HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WS,other,ROOM]);
  expect((await post('@other this post is for you')).woken).toEqual([]);
  const second = await post('No tag in this next post.');
  expect(second.woken).toEqual([]);
  const skipped = await post('@captain see this');
  expect(skipped.woken).toEqual([]);
  expect(skipped.stored).toBe(true);
  expect((await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [skipped.id])).rows[0]?.text).toBe('@captain see this');
  const quoted = await post('"@ruby, or any squire agent except Speedy."');
  expect(quoted.woken).toEqual([]);
  expect((await post('Correction: my quote of "@ruby" in that reply woke Ruby. That was my error. Ruby has no task here.')).woken).toEqual([]);
  expect((await post('The next post has no tag.')).woken).toEqual([]);
  expect((await post('@ruby fresh tag')).woken).toEqual([]);
  expect((await post('"start ```\ncode\n``` @ruby"')).woken).toEqual([]);
});



it('Reproduction R1: exact original posts do not wake the quoted member', async () => {
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE identities SET handle='nerd' WHERE id=$1`, [RUBY]);
  try {
    const receipts = [];
    for (const text of quotedTagPosts) {
      const receipt = await rootFixture.daemon.execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text }, WORKER);
      receipts.push(receipt);
      expect((await rootFixture.db.query('SELECT text FROM messages WHERE id=$1', [receipt.id])).rows[0]?.text).toBe(text);
    }
    console.info('Reproduction R1 post receipts:', JSON.stringify(receipts.map(receipt => receipt.woken)));
    for (const receipt of receipts) {
      expect(receipt.woken).toEqual([]);
      expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [receipt.id, RUBY])).rowCount).toBe(0);
    }
  } finally { await rootFixture.db.query(`UPDATE identities SET handle='ruby' WHERE id=$1`, [RUBY]); }
});


// Reproduction OPEN-1: use the same public daemon operation as open_thread.
it.each([undefined, 'agent-context'])('OPEN-1: opens without human approval (%s)', async (sourceMessageId) => {
  if (sourceMessageId) await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Investigate the widget')`,
    [sourceMessageId, ROOM, WORKER]);
  const opened = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false,
      ...(sourceMessageId ? { approval: { sourceMessageId } } : {}) },
  }, RUBY);
  expect((await rootFixture.db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: {
      kind: 'agent-initiated', approvedBy: RUBY, snapshot: 'Agent-initiated thread',
  } });
  expect((await commands(opened.cornerId, WORKER))[0]).toBeDefined();
});

it('OPEN-1: preserves human approval text and attribution', async () => {
  const opened = await open();
  expect((await rootFixture.db.query(`SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1`,
    [opened.cornerId])).rows[0]).toMatchObject({ approval_basis: {
      approvedBy: HUMAN, snapshot: 'Build the widget in the target Room',
  } });
});

it('OPEN-1: refuses a non-member opening without approval', async () => {
  await rootFixture.db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`, [ROOM, RUBY]);
  await expect(rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false },
  }, RUBY)).rejects.toThrow('daemon chat access denied');
});


it('OPEN-1: an agent-initiated opening does not authorize a worker revision', async () => {
  const opened = await rootFixture.daemon.execute('createCorner', { ...authority(rootFixture.order), targetRoomId: ROOM,
    name: 'Agent-widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false },
  }, RUBY);
  const turn = await worker(opened.cornerId);
  await expect(rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Change the widget', change: 'Adjust scope' },
  }, WORKER)).rejects.toThrow('brief.approval.sourceMessageId');
});

it.each([false, true])('Reproduction 572a0de1: same-address post then matching final is visible once (tagged=%s)', async tagged => {
  const text = `${tagged ? '@captain ' : ''}Google sign-in (#2676) is merged. The checks passed.`;
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text }, RUBY);
  const messages = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message');
  expect(messages.map(m => m.id)).toEqual([posted.id]);
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [rootFixture.order.id])).rows[0]?.state).toBe('complete');
  console.info(`Demonstrated Reproduction ${duplicateReproduction}: post + final -> one visible message`);
});


it('Reproduction R1: a same-place closing summary stays in activity even with an additional sentence', async () => {
  const text = 'Google sign-in (#2676) is merged. The checks passed.';
  await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  const final = `${text} You still need to approve the release.`;
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: final }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.text))
    .toEqual([text]);
});


it('R-onb-15: a free agent post stays visible and the paraphrased final becomes activity', async () => {
  await rootFixture.db.query(`WITH workspace AS (SELECT $2::uuid) INSERT INTO free_agents(agent_id,owner_id,sealed_keys) VALUES($1,$3,'fixture')`,
    [RUBY,WS,HUMAN]);
  const earlier = 'The card is up. Sign in to Link, then name the repository and I will start.';
  const final = 'The Link sign-in card is in the Room now. Sign in, then name the repo and I start.';
  await rootFixture.daemon.execute('postCornerMessage', {...authority(rootFixture.order),cornerId:DM,text:earlier}, RUBY);
  await rootFixture.daemon.execute('postRoomMessage', {...authority(rootFixture.order),text:final}, RUBY);
  const messages = (await rootFixture.phone.readRoom(DM,HUMAN))!.messages.filter(message=>message.author.pubkey===RUBY);
  expect(messages.filter(message=>message.presentation==='message').map(message=>message.text)).toEqual([earlier]);
  expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='activity'`,[DM,RUBY])).rows)
    .toContainEqual({text:final});
});


it('Reproduction ff0ec4df: a mid-turn post keeps its row while the closing narration folds', async () => {
  const list = 'Groceries: rice, lentils, cardamom. Deliver to Mohammed before six.';
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: list }, RUBY);
  const narration = 'Posted the list above and told Mohammed it is coming before six.';
  const reply = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: narration }, RUBY);
  expect(reply.id).toBe(posted.id);
  await rootFixture.db.backgroundWork.drain();
  const rows = (await rootFixture.db.query<{ id: string; text: string; presentation: string; version: number }>(
    `SELECT id,text,presentation,version FROM messages WHERE request_id=$1`, [rootFixture.order.id])).rows;
  expect(rows.find(row => row.id === posted.id)).toMatchObject({ text: list, presentation: 'message', version: 0 });
  expect(rows.find(row => row.presentation === 'activity')).toMatchObject({ text: narration, presentation: 'activity', version: 0 });
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.author.pubkey === RUBY && m.presentation === 'message').map(m => m.text))
    .toEqual([list]);
  console.info('Demonstrated Reproduction ff0ec4df: the closing reply is stored directly as activity (version 0); the posted list is untouched (version 0)');
});


it.each(['other-address', 'other-request', 'deleted'] as const)('dedupe does not suppress a final after a post in %s', async scope => {
  const text = 'Google sign-in is merged.';
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: scope === 'other-address' ? ROOM : DM, text }, RUBY);
  if (scope === 'other-request') await rootFixture.db.query(`UPDATE messages SET request_id='old' WHERE id=$1`, [posted.id]);
  if (scope === 'deleted') await rootFixture.db.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [posted.id]);
  const final = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text }, RUBY);
  expect((await rootFixture.phone.readRoom(DM, HUMAN))!.messages.find(m => m.id === final.id)?.presentation).toBe('message');
});


it('dedupe retains activity and accepts an identical final retry', async () => {
  const text = 'Google sign-in is merged.';
  await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  const steps = [{ kind: 'tool' as const, title: 'post', status: 'completed' as const }];
  const final = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text, steps }, RUBY);
  const replay = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text, steps }, RUBY);
  expect(replay.id).toBe(final.id);
  await rootFixture.db.backgroundWork.drain();
  expect((await rootFixture.db.query(`SELECT presentation,activity FROM messages WHERE request_id=$1 AND presentation='activity'`, [rootFixture.order.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [...steps, { kind: 'note', title: 'Turn summary', text }] });
});


it('neither an agent tag nor its collapsed final wakes another agent', async () => {
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, DM, WORKER]);
  const text = '@worker Google sign-in is merged.';
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text }, RUBY);
  expect((await rootFixture.db.query(`SELECT source_message_id FROM agent_commands WHERE agent_id=$1 AND reason='agent_tag'`, [WORKER])).rows)
    .toEqual([]);
  expect(posted.woken).toEqual([]);
});


it('dedupe keeps a lightly reworded summary in collapsed activity', async () => {
  const text = 'Google sign-in (#2676) is merged. The checks passed and the account linking flow is ready for review.';
  await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text }, RUBY);
  const final = text.replace('and the account', 'and account');
  const result = await rootFixture.daemon.execute('postRoomMessage', { ...authority(rootFixture.order), text: final }, RUBY);
  await rootFixture.db.backgroundWork.drain();
  expect((await rootFixture.db.query(`SELECT presentation,activity FROM messages WHERE request_id=$1 AND presentation='activity'`, [rootFixture.order.id])).rows[0])
    .toMatchObject({ presentation: 'activity', activity: [{ kind: 'note', title: 'Turn summary', text: final }] });
});

it.each(['agent_tag','corner_review_dispatch'])('a failed diagnostic for %s leaves the item queued for its own answer',async reason=>{
  const opened=await open();const queued=(await createAgentCommand(rootFixture.db,{roomId:opened.cornerId,agentId:WORKER,sourceMessageId:null,reason}))!;
  const turn=(await commands(opened.cornerId,WORKER)).find(command=>command.id===queued.id)!;await claim(turn);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'failed',reason:'checkout preparation failed'},WORKER);
  expect((await commands(opened.cornerId,WORKER)).map(command=>command.id)).toContain(queued.id);
  await rootFixture.daemon.execute('postRoomMessage',{...authority(turn),text:'I could not prepare the checkout.'},WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[queued.id])).rows).toEqual([{state:'complete'}]);
});

it('a human-issued order stays queued after setup diagnostics and its answer returns to the person',async()=>{
  const opened=await open(),queued=(await createAgentCommand(rootFixture.db,{roomId:opened.cornerId,agentId:WORKER,sourceMessageId:null,reason:'order',privatePayload:{kind:'order',authorId:HUMAN,fromRoomId:ROOM,text:'Review this'}}))!;
  const turn=(await commands(opened.cornerId,WORKER)).find(command=>command.id===queued.id)!;await claim(turn);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{...authority(turn),status:'failed',reason:'spawn failed'},WORKER);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[queued.id])).rows).toEqual([{state:'pending'}]);
  const text='Worker stopped while answering this: spawn failed';
  await rootFixture.daemon.execute('postRoomMessage',{...authority(turn),text},WORKER);
  expect((await rootFixture.phone.readRoom(ROOM,HUMAN))!.messages.some(message=>message.text===text)).toBe(true);
});
