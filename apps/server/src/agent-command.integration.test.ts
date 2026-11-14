import { migrate } from './database.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { describe, expect, it, taggedIdentityIdsSql, seedCornerOpening, PhoneService, DaemonService, createAgentCommand, H, A, B, P, R, C, id, stopProofPostgresUrl, db, phone, daemon, live, commands, send, disconnectHelper, helperOwner, queuedHumanTags, queueStopOrders, claim, result, rootFixture, fixtureScope1, type SqlDatabase } from './test-support-agent-command.integration.test-support.js';




it('RUBY-RESOURCE-ACCESS: release migration retains a running helper request identity', async () => {
  await rootFixture.db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES('ruby-resource-root',$1,$2,'Check the service')", [R,H]);
  const queued = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A,
    sourceMessageId: 'ruby-resource-root', reason: 'human_tag' });
  const requestId = 'already-delivered-request';
  await rootFixture.db.query('UPDATE agent_commands SET turn_request_id=$2 WHERE id=$1', [queued!.id, requestId]);
  await migrate(rootFixture.db);
  const delivered = (await commands(A, R)).find(item => item.id === queued!.id)!;
  expect(delivered.turnRequestId).toBe(requestId);
  // The original helper keeps its authority even if the command is answered
  // before its next resource call. An explicit Stop remains a refusal.
  await rootFixture.daemon.execute('authorizeResourceCall', { roomId: R, requestId,
    target: 'squire', consume: false, appKeys: ['fly'] }, A);
  await result(delivered, 'The requested work is done.');
  await expect(rootFixture.daemon.execute('authorizeResourceCall', { roomId: R, requestId,
    target: 'squire', consume: false, appKeys: ['fly'] }, A)).resolves.toBeDefined();
});

it.each(['ordinary', 'tagged', 'threaded', 'private', 'private-agent', 'corner', 'dm'])(
  'a silence acknowledgement preserves the answer obligation on the %s path', async path => {
    const roomId = path === 'corner' ? C : R;
    if (path === 'dm') await rootFixture.db.query('UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1', [R, JSON.stringify([H,A])]);
    const queued = await createAgentCommand(rootFixture.db, { roomId, agentId:A, sourceMessageId:null,
      reason:path.startsWith('private')?'order':'system', ...(path.startsWith('private')?{
        privatePayload:{kind:'order',authorId:path==='private-agent'?B:H,fromRoomId:R,text:'Please answer'}}:{}) });
    const command=(await commands(A,roomId)).find(c=>c.id===queued!.id)!;
    await claim(command);
    expect(await rootFixture.daemon.execute('markAgentTurnSilent',{roomId,requestId:command.turnRequestId},A)).toMatchObject({answered:false});
    expect((await commands(A,roomId)).map(c=>c.id)).toContain(command.id);
    const text='Here is the requested answer for '+path+(path==='tagged'?' @goosy':'');
    const posted=await result(command,text);
    expect((await result(command,text)).id).toBe(posted.id);
    expect((await commands(A,roomId)).map(c=>c.id)).not.toContain(command.id);
    if(path==='private-agent') expect((await commands(B)).some(c=>c.source.body.includes(text))).toBe(true);
    else expect((await rootFixture.db.query('SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2',[A,text])).rows).toEqual([{n:1}]);
  });



// R3: with text-pattern suppression removed, agent final text publishes as
// written on any wake. The only silence path is the no_reply_needed tool
// (a 'no-reply' completion receipt), which discards the turn's final text.
it.each(['I posted nothing.', 'Nothing to post.', "I won't post to the Room.", 'NO_REPLY', 'No reply needed.',
  'Nonhuman wake only … Ending silently',
  'Posted a concise Arabic list … Waiting for Mohammed',
  'blocked: Corner release is idle with no worker schedule or event subscription',
])(
  'WAKE-STORM: final text publishes as written on a system wake: %s', async text => {
    const queued = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'system' });
    const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
    await claim(command);
    await result(command, text);
    expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
      [command.turnRequestId, A, text])).rowCount).toBe(1);
    expect((await rootFixture.db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
      [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
  });





it('WAKE-STORM: a human wake publishes its report-status reply as written', async () => {
  const queued = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null, reason: 'human_tag' });
  const command = (await commands(A, R)).find(c => c.id === queued!.id)!;
  await claim(command);
  const text = 'blocked: Corner release is idle with no worker schedule or event subscription';
  await result(command, text);
  expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE request_id=$1 AND author_id=$2 AND text=$3',
    [command.turnRequestId, A, text])).rowCount).toBe(1);
  expect((await rootFixture.db.query('SELECT completion_kind FROM agent_turns WHERE request_id=$1 AND agent_id=$2',
    [command.turnRequestId, A])).rows[0]?.completion_kind).toBeFalsy();
});

it.each([R, C])('QUEUED-TAGS-REPEAT: each queued human tag needs its own answer in %s', async roomId => {
  const messages = await queuedHumanTags(roomId);
  const snapshot = await commands(A, roomId);
  expect(snapshot.map(command => command.sourceMessageId)).toEqual(messages.map(message => message.messageId));
  for (const [index, command] of snapshot.entries()) {
    await claim(command);
    await result(command, `Answer ${index}`);
    expect((await commands(A, roomId)).map(row => row.id)).toEqual(snapshot.slice(index + 1).map(row => row.id));
  }
  expect((await rootFixture.phone.readRoom(roomId, H))!.pendingAgentCommands).toEqual([]);
});

it.each([0, 1, 2])('QUEUED-TAGS-REPEAT: Stop message %s preserves the other requests', async stopIndex => {
  const messages = await queuedHumanTags();
  const snapshot = await commands();
  const stopped = snapshot[stopIndex]!;
  await claim(stopped);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: stopped.id }, H);
  await expect(result(stopped, 'Must never publish')).rejects.toThrow();
  expect((await commands()).filter(command => command.action === 'input').map(command => command.id)).toEqual(snapshot.filter(command => command.id !== stopped.id).map(command => command.id));
});

it.each(['deleted', 'stopped'])('QUEUED-TAGS-REPEAT: reconnect preserves unrelated work after a source is %s', async kind => {
  const messages = await queuedHumanTags();
  const snapshot = await commands();
  await claim(snapshot[0]!);
  if (kind === 'deleted')
    await rootFixture.db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [messages[1]!.messageId]);
  else await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: snapshot[1]!.id }, H);
  await disconnectHelper();
  await helperOwner(A);
  // The reconnected helper resumes the running turn in its own generation.
  await claim(snapshot[0]!);
  await result(snapshot[0]!, 'First answer');
  expect((await commands()).filter(command => command.action === 'input').map(command => command.sourceMessageId)).toEqual((kind === 'deleted' ? messages.slice(1) : messages.slice(2)).map(message => message.messageId));
});

it('QUEUED-TAGS-REPEAT: source snapshots retain their own attachments after later edits', async () => {
  const files=[0,1,2].map(index=>({url:`https://files.example.test/file-${index}.txt`,name:`file-${index}.txt`,mimeType:'text/plain',size:index+1}));
  for(const [index,file] of files.entries()) await rootFixture.phone.execute('sendRoomMessage',
    {roomId:R,text:`@hoots file ${index}`,attachments:[file]},H);
  const snapshot=await commands();
  await rootFixture.db.query("UPDATE messages SET attachments='[]'::jsonb WHERE id=ANY($1::text[])",[snapshot.map(item=>item.sourceMessageId)]);
  for(const [index,command] of snapshot.entries()) {
    expect(command.source.attachments).toEqual([files[index]]);
    await claim(command);await result(command,`File ${index} answered`);
  }
});

it('Reproduction cold-beebee-first-reply: shows every queued agent, then only its claimed turn as working', async () => {
  await send('@hoots @goosy Hello');
  const before = await rootFixture.phone.readRoom(R, H);
  expect(before?.pendingAgentCommands).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentPubkey: A }),
    expect.objectContaining({ agentPubkey: B }),
  ]));
  expect(before?.latestAgentTurns?.filter(turn => turn.status === 'working')).toEqual([]);
  const pending = await rootFixture.db.query(`SELECT state FROM agent_commands WHERE agent_id IN ($1,$2)`, [A,B]);
  expect(pending.rows).toEqual([{ state: 'pending' }, { state: 'pending' }]);
  await rootFixture.db.query(`UPDATE agent_turns SET started_at=now()-interval '17 minutes' WHERE agent_id=$1`, [A]);
  const [command] = await commands();
  await claim(command!, 'real-helper');
  expect((await rootFixture.db.query<{ fresh: boolean }>(`SELECT started_at>now()-interval '1 second' fresh
    FROM agent_turns WHERE agent_id=$1`, [A])).rows[0]?.fresh).toBe(true);
  const after = await rootFixture.phone.readRoom(R, H);
  expect(after?.latestAgentTurns?.filter(turn => turn.agentPubkey === A)).toEqual([
    expect.objectContaining({ status: 'working' }),
  ]);
  expect(after?.pendingAgentCommands).toEqual(expect.arrayContaining([expect.objectContaining({ agentPubkey: A }), expect.objectContaining({ agentPubkey: B })]));
});


it('Reproduction stop-queued-orders: Stop drains the queued orders and wakes no commander', async () => {
  const { queued } = await queueStopOrders();
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(0);
  for (const command of queued) await expect(claim(command, 'stale-helper')).rejects.toThrow();
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=ANY($1::text[])`,
    [queued.map(command => command.id)])).rows).toEqual(Array(3).fill({ state: 'cancelled' }));
  // The Stop line below is the record; no generated report is queued under the worker's name.
  expect((await commands(B)).filter(command => command.reason === 'report')).toHaveLength(0);
  const lines = await rootFixture.db.query<{ text: string }>(
    `SELECT text FROM messages WHERE room_id=$1 AND system_event->>'kind'='turn-cancelled'
     AND request_id=$2`, [R, queued[0]!.turnRequestId]);
  expect(lines.rows).toHaveLength(1);
  expect(lines.rows[0]!.text).toContain('turn cancelled · 2 queued orders dropped');
  console.log('Demonstrated Reproduction stop-queued-orders: queue 3, claim first, owner Stop → all 3 cancelled, 0 input commands available, all cached claims refused, one count line and no generated report');
});


it('Stop preserves other senders, source Rooms, targets, human mentions and newer orders', async () => {
  const { queued, root } = await queueStopOrders();
  for (const [authorId, fromRoomId, agentId] of [[H, R, A], [B, C, A], [H, R, B]]) {
    await createAgentCommand(rootFixture.db, { roomId: R, agentId: agentId!, sourceMessageId: null,
      privatePayload: { kind: 'order', authorId: authorId!, fromRoomId: fromRoomId!, text: 'survivor' }, reason: 'order' });
  }
  await send('@hoots Human follow-up');
  const newer = await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null,
    privatePayload: { kind: 'order', authorId: B, fromRoomId: R, text: 'newer order' }, reason: 'order' });
  await rootFixture.db.query(`UPDATE agent_commands SET created_at=now()+interval '1 minute' WHERE id=$1`, [newer!.id]);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  const remaining = (await commands()).filter(command => command.action === 'input');
  expect(remaining).toHaveLength(4);
  expect(remaining.some(command => command.source.body.includes('Human follow-up'))).toBe(true);
  expect(remaining.some(command => command.id === newer!.id)).toBe(true);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state='pending' AND private_payload->>'text'='survivor'`, [B])).rowCount).toBe(1);
  await rootFixture.daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: 'after Stop', requestId: root.turnRequestId }, B);
  const after = (await commands()).find(command => command.source.body.includes('after Stop'))!;
  await expect(claim(after)).resolves.toBeUndefined();
});


it('tagged human Stop drains queued orders without inventing a public reply', async () => {
  const { queued } = await queueStopOrders();
  await send('@hoots stop');
  expect((await commands()).filter(command => command.action === 'input')).toHaveLength(0);
  expect((await commands(B)).filter(command => command.reason === 'report')).toHaveLength(0);
  for (const command of queued) await expect(claim(command, 'late-helper')).rejects.toThrow();
  const line = await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages
    WHERE room_id=$1 AND system_event->>'verb'='stopped its running turn' ORDER BY created_at DESC LIMIT 1`, [R]);
  expect(line.rows).toEqual([]);
});


it.runIf(Boolean(stopProofPostgresUrl))('Stop preserves an order accepted while its transaction is in progress', async () => {
  const { queued, root } = await queueStopOrders();
  let reached!: () => void, release!: () => void, orderStarted!: () => void;
  const stopped = new Promise<void>(resolve => { reached = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const queuedOrder = new Promise<void>(resolve => { orderStarted = resolve; });
  const wrap = (database: SqlDatabase, stopping: boolean): SqlDatabase => ({
    query: async (sql, values) => {
      if (!stopping && sql.includes('FOR SHARE OF room,member')) orderStarted();
      const result = await database.query(sql, values);
      if (stopping && sql.startsWith('SELECT * FROM beeline_finish_agent_command(') &&
          values?.[1] === 'cancelled' && values?.[2] === 'stop') {
        reached();
        await resume;
      }
      return result;
    },
    transaction: work => database.transaction(transaction => work(wrap(transaction, stopping))),
  });
  const stop = new PhoneService(wrap(db, true), 'http://test').execute('cancelAgentTurn',
    { roomId: R, agentId: A, requestId: queued[0]!.turnRequestId }, H);
  let arriving: Promise<unknown> | undefined;
  try {
    await Promise.race([stopped, stop.then(() => { throw new Error('Stop did not reach its terminal write'); })]);
    arriving = new DaemonService(wrap(db, false), live).execute('order', {
      roomId: R, address: R, agent: 'hoots', text: 'arrived during Stop', requestId: root.turnRequestId,
    }, B);
    await Promise.race([queuedOrder, arriving.then(() => { throw new Error('Order did not reach insertion'); })]);
    release();
    await stop;
    await arriving;
    const surviving = await commands();
    expect(surviving).toHaveLength(1);
    expect(surviving[0]!.source.body).toContain('arrived during Stop');
  } finally {
    release();
    await Promise.allSettled([stop, ...(arriving ? [arriving] : [])]);
  }
});


it('preserves each fresh follow-up while another request is being answered', async () => {
  for (const text of ['First request', 'Second request', 'Third request']) await send(`@hoots ${text}`);
  const pending = await commands();
  expect(pending).toHaveLength(3);
  await claim(pending[0]!);
  expect((await commands()).map(command => command.id)).toEqual(pending.map(command => command.id));
  await result(pending[0]!, 'First answer');
  expect((await commands()).map(command => command.source.body)).toEqual(['@hoots Second request', '@hoots Third request']);
});


it('keeps rapid online follow-ups across a brief socket reconnect', async () => {
  await rootFixture.db.query(`INSERT INTO live_server_instances(instance_id) VALUES('online-test') ON CONFLICT DO NOTHING`);
  await rootFixture.db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
    VALUES($1,1,'online-test','online-test')`, [A]);
  await send('@hoots First online request');
  await send('@hoots Second online request');
  await send('@hoots Third online request');
  await rootFixture.db.query(`UPDATE agent_connections SET connected_at=clock_timestamp() WHERE agent_id=$1`, [A]);
  expect(await commands()).toHaveLength(3);
});


it('bootstrap identifies only pending member surfaces, including the corner parent', async () => {
  // B opened the corner: its opening order owns the corner's kind and owner.
  await seedCornerOpening(rootFixture.db, { cornerId: C, agentId: B });
  await send('@hoots Wake the Room');
  await send('@hoots Wake the corner', C);
  const bootstrap = await rootFixture.daemon.execute('getDaemonBootstrap', { agentId: A }, A);
  expect(bootstrap.pendingRooms).toEqual(expect.arrayContaining([
    { roomId: R }, { roomId: C, parentRoomId: R, openedBy: B },
  ]));
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`, [A, R]);
  expect((await rootFixture.daemon.execute('getDaemonBootstrap', { agentId: A }, A)).pendingRooms).toEqual([]);
});


it.each([R, C])('projects reply context outside the conversation window in %s', async (roomId) => {
  await rootFixture.db.query(`UPDATE messages SET created_at=now()-interval '1 day' WHERE room_id=$1`, [roomId]);
  const parentId = id();
  const parentText = 'Five corners from the audit: '.repeat(30);
  await rootFixture.db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
    [parentId, roomId, B, parentText]);
  const sent = await rootFixture.phone.execute('sendRoomReply', {
    roomId, parentMessageId: parentId, text: '@hoots Dispatch these five corners',
  }, H);
  const command = (await commands(A, roomId)).find((c) => c.sourceMessageId === sent.messageId)!;
  expect(command).toBeDefined();
  const reply={replyToMessageId:parentId};
  expect(command.source).toMatchObject(reply);
  expect(command.source.replyToExcerpt).toBeUndefined();
  const inbox = await rootFixture.daemon.execute('getRoomInbox', { roomId }, A);
  expect(inbox.items.find((m) => m.id === sent.messageId)).toMatchObject(reply);
  const conversation = await rootFixture.daemon.execute('getRoomConversation', { roomId, limit: 1 }, A);
  expect(conversation.items).toHaveLength(1);
  expect(conversation.items[0]).toMatchObject(reply);
  expect(conversation.items[0]?.id).toBe(sent.messageId);
  expect(conversation.items[0]?.replyToExcerpt).toMatch(/^Five corners from the audit: .*…$/);
  expect(conversation.items[0]?.replyToExcerpt?.length).toBeLessThanOrEqual(300);
  console.log('Reproduction reply-context: queue freezes parent ID; explicit conversation read supplies the excerpt');
});


it('Reproduction workflow-corner-objective: a corner objective rooted on a parent workflow handoff carries no run instruction', async () => {
  // A workflow handoff card in the parent Room R carries the run id, workflow
  // name and a receipt hint, exactly as a real handoff does. When a workflow
  // step opens a corner, `createCorner` roots the corner objective command on
  // this parent-Room message, so the read path sees it in the corner.
  const parentRunId = id();
  const parentHandoffId = id();
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      parentHandoffId,
      R,
      A,
      'Hoots handed off workflow feedback-triage',
      JSON.stringify({
        runId: parentRunId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(rootFixture.db, {
    roomId: C,
    agentId: B,
    sourceMessageId: parentHandoffId,
    reason: 'corner_objective',
  });
  const [objective] = await commands(B, C);
  expect(objective?.reason).toBe('corner_objective');
  // The parent run is not reachable from the corner: its first turn must not
  // tell the implementer to hand off a run that lives in another Room.
  expect(objective?.source.body).not.toContain('You are in run');
  expect(objective?.source.body).not.toContain('This wake is attempt');
  expect(objective?.source.body).not.toContain('Receipt hint for this state');
  console.log(
    `Reproduction workflow-corner-objective: a corner objective rooted on the parent Room handoff (run ${parentRunId}) reads as: ${JSON.stringify(objective?.source.body)}`,
  );
});


it('a workflow wake for a run in the turn’s own Room still carries the run instruction', async () => {
  const runId = id();
  const handoffId = id();
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,card_type,card)
     VALUES($1,$2,$3,$4,'workflow-handoff',$5::jsonb)`,
    [
      handoffId,
      C,
      A,
      'Hoots handed off workflow feedback-triage',
      JSON.stringify({
        runId,
        workflowSlug: 'feedback-triage',
        toState: 'dispatch',
        seq: 6,
        receiptHint: 'Finish dispatch then stop.',
      }),
    ],
  );
  await createAgentCommand(rootFixture.db, {
    roomId: C,
    agentId: B,
    sourceMessageId: handoffId,
    reason: 'workflow_handoff',
  });
  const [wake] = await commands(B, C);
  expect(wake?.source.body).toContain(`You are in run ${runId} of feedback-triage`);
  expect(wake?.source.body).toContain('This wake is attempt 6');
  console.log(
    `Demonstrated workflow-corner-objective: a same-Room workflow wake (run ${runId}) still reads as: ${JSON.stringify(wake?.source.body)}`,
  );
});


it('lets the corner agent retitle its corner during its turn', async () => {
  // B opened the corner: its opening order owns the corner's kind and owner.
  await seedCornerOpening(rootFixture.db, { cornerId: C, agentId: B });
  await send('@hoots plan the launch', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const rename = (name: string) =>
    rootFixture.daemon.execute(
      'renameCorner',
      { cornerId: C, requestId: command!.turnRequestId, name },
      A,
    );

  await expect(rename('too many words for a title')).resolves.toMatchObject({ cornerId: C, name: 'too-many-words' });
  await expect(rename('  Launch\n plan ')).resolves.toMatchObject({ cornerId: C, name: 'Launch-plan' });
  await expect(rename('Launch-plan')).resolves.toEqual({ cornerId: C, name: 'Launch-plan' });
  expect((await rootFixture.phone.readRoom(C, H))?.room.name).toBe('Launch-plan');
  await result(command!, 'Renamed.');
  await expect(rename('Follow-up title')).resolves.toMatchObject({name:'Follow-up-title'});
  await rootFixture.db.query(`UPDATE rooms SET name='Corner' WHERE id=$1`, [C]);
});


it.each(['room', 'corner', 'dm'])(
  'Reproduction F1: a follow-up in a %s queues and the running turn stays the one shown working',
  async (path) => {
    const room = path === 'corner' ? C : R;
    if (path === 'dm')
      await rootFixture.db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [R, JSON.stringify([H, A])]);
    try {
      await send(path === 'dm' ? 'start' : '@hoots start', room);
      const [running] = await commands(A, room);
      await claim(running!);
      const followUp = await send(path === 'dm' ? 'one more thing' : '@hoots one more thing', room);
      const shown = await rootFixture.phone.readRoom(room, H);
      expect(shown?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A)).toEqual([
        expect.objectContaining({ requestId: running!.turnRequestId, status: 'working' }),
      ]);
      const queued = (await commands(A,room)).find(item => item.sourceMessageId === followUp.messageId);
      expect(queued).toMatchObject({agentId:A});
      expect(queued!.turnRequestId).not.toBe(running!.turnRequestId);
      expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2
        AND request_id=$3`, [room, A, running!.turnRequestId])).rows).toEqual([{ status: 'working' }]);

      // Once the running turn ends, the queued follow-up's claim paints its own turn.
      await result(running!, 'Started');
      const next = (await commands(A, room)).find((command) => command.sourceMessageId === followUp.messageId);
      await claim(next!);
      expect((await rootFixture.phone.readRoom(room, H))?.latestAgentTurns?.filter((turn) => turn.agentPubkey === A))
        .toEqual([expect.objectContaining({ requestId: next!.turnRequestId, status: 'working' })]);
      await result(next!, 'Done');
    } finally {
      await rootFixture.db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
    }
  },
);
describe.each([R, C])('server command authority in %s', (room) => {
const scope1 = fixtureScope1(room);

  it('acknowledges a committed human steer only while its targeted turn is active', async () => {
    const first = await send('@hoots start', scope1.room);
    const [active] = await commands(A, scope1.room);
    await claim(active!);

    const steerId = id();
    const received = await rootFixture.phone.execute(
      'sendRoomMessage',
      { roomId: scope1.room, messageId: steerId, text: '@hoots change course' },
      H,
    );
    expect(received).toMatchObject({ messageId: steerId, activeSteerAgentIds: [A],
      message: { id: steerId, text: '@hoots change course' } });
    expect((await commands(A, scope1.room)).map((command) => command.sourceMessageId)).toContain(steerId);

    // A retried write reads the same committed routing result instead of
    // falling back to a client-side guess.
    await expect(
      rootFixture.phone.execute(
        'sendRoomMessage',
        { roomId: scope1.room, messageId: steerId, text: '@hoots change course' },
        H,
      ),
    ).resolves.toEqual(received);

    await result(active!, 'Finished');
    const idleId = id();
    await expect(
      rootFixture.phone.execute(
        'sendRoomMessage',
        { roomId: scope1.room, messageId: idleId, text: '@hoots next task' },
        H,
      ),
    ).resolves.toMatchObject({ messageId: idleId, activeSteerAgentIds: [],
      message: { id: idleId, text: '@hoots next task' } });
    expect(first.messageId).toBe(active!.sourceMessageId);
  });


  it('routes a human message to an agent only when the message addresses it', async () => {
    // A typed tag routes.
    await send('@hoots ask Goosy', scope1.room);
    const [first] = await commands(A, scope1.room);
    expect(first).toBeDefined();
    await claim(first!);
    await result(first!, 'Tag @goosy and Goosy answers');
    const [tagged] = await commands(B, scope1.room);
    expect(tagged).toBeDefined();
    await claim(tagged!);
    await result(tagged!, 'Goosy answered');
    expect(await commands(A, scope1.room)).toEqual([]);

    // An untagged message routes to nobody, even when an agent wrote the
    // immediately preceding message: transcript adjacency starts no turn.
    await send('Thanks everyone', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);

    // A reply to an agent starts with the parent agent's @handle in the mobile
    // composer (apps/mobile/sources/buzz/composer-prefill.ts), so it routes as
    // a tag.
    const agentReply = (
      await rootFixture.db.query<{ id: string; text: string }>(
        `SELECT id,text FROM messages WHERE room_id=$1 AND author_id=$2 AND presentation='message'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [scope1.room, B],
      )
    ).rows[0]!;
    expect(agentReply.text).toBe('Goosy answered');
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: agentReply.id, text: '@goosy Thanks again' },
      H,
    );
    const [replyCommand] = await commands(B, scope1.room);
    expect(replyCommand?.reason).toBe('human_tag');
    expect(replyCommand?.sourceMessageId).not.toBe(agentReply.id);
    expect(await commands(A, scope1.room)).toEqual([]);
    await claim(replyCommand!);
    await result(replyCommand!, 'Settled');

    // Untagged messages after human traffic still route to nobody.
    await send('An intervening human message', scope1.room);
    await send('This is not a continuation', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);
  });

  it('preserves provenance through the former depth boundary', async () => {
    await send('@hoots start', scope1.room);
    let [c] = await commands(A, scope1.room);
    const root = c!.id;
    for (let depth = 0; depth <= 3; depth++) {
      expect(c!.agentDepth).toBe(depth);
      expect(c!.rootCommandId).toBe(root);
      await claim(c!);
      const target = c!.agentId === A ? B : A;
      await result(c!, `@${target === A ? 'hoots' : 'goosy'} depth ${depth}`);
      const next = await commands(target, scope1.room);
      expect(next).toHaveLength(1);
      expect(next[0]?.agentDepth).toBe(depth + 1);
      c = next[0];
    }
  });

  it('routes replies only through exact tags', async () => {
    await send('@hoots start', scope1.room);
    const [a] = await commands(A, scope1.room);
    await claim(a!);
    const posted = await result(a!, '@goosy Delegation');
    const [b] = await commands(B, scope1.room);
    await claim(b!);
    const reply = await result(b!, 'Deliberate reply', 'g1', { replyToMessageId: posted.id });
    expect(await commands(A, scope1.room)).toEqual([]);
    await send('@goosy Start a tagged handoff', scope1.room);
    const fresh = (await commands(B, scope1.room))[0]!;
    await claim(fresh!);
    const taggedReply = await result(fresh!, '@hoots Deliberate handoff');
    expect((await commands(A, scope1.room))[0]?.agentDepth).toBe(1);
    await rootFixture.db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [B]);
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: reply.id, text: 'Continue' },
      H,
    );
    expect(await commands(B, scope1.room)).toEqual([]);
    await rootFixture.phone.execute(
      'sendRoomReply',
      { roomId: scope1.room, parentMessageId: taggedReply.id, text: '@goosy Continue' },
      H,
    );
    expect((await commands(B, scope1.room))[0]?.agentDepth).toBe(0);
  });

  it('wakes no agent whose handle appears only inside code', async () => {
    await send('@hoots review the probe', scope1.room);
    const [review] = await commands(A, scope1.room);
    await claim(review!);
    await result(
      review!,
      'FAIL. The probe reads `@goosy and @hoots take it`.\n\n```\n@goosy fix R1\n```\nNo tag here.',
    );
    expect(await commands(B, scope1.room)).toEqual([]);

    await send('Quoting `@goosy` and\n```\n@hoots\n```', scope1.room);
    expect(await commands(A, scope1.room)).toEqual([]);
    expect(await commands(B, scope1.room)).toEqual([]);

    await send('Run `npm test` then @goosy take a look', scope1.room);
    expect(await commands(B, scope1.room)).toHaveLength(1);
  });
});

it('resolves multiple natural tags and ignores human-only and unknown tags', async () => {
  await send('@hoots and @goosy');
  expect(await commands(A)).toHaveLength(1);
  expect(await commands(B)).toHaveLength(1);
  await send('@person @missing');
  expect(await commands(A)).toHaveLength(1);
  const human = await send('Human text');
  await rootFixture.phone.execute(
    'sendRoomReply',
    { roomId: R, parentMessageId: human.messageId, text: 'Reply' },
    H,
  );
  expect(await commands(A)).toHaveLength(1);
});

it('routes Latin case variants while keeping unknown spellings as prose', async () => {
  await send('@Hoots @ｈｏｏｔｓ @hoots-old');
  expect(await commands(A)).toHaveLength(1);
  await send('@hoots');
  expect(await commands(A)).toHaveLength(2);
});

it('routes a direct message without redundant tags or a presence row', async () => {
  await rootFixture.db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`, [
    R,
    JSON.stringify([H, A]),
  ]);
  try {
    await rootFixture.db.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A]);
    await send('Hello');
    expect((await commands(A))[0]?.reason).toBe('direct_message');
    expect(await commands(B)).toEqual([]);
  } finally {
    await rootFixture.db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
  }
});

it('routes member requests regardless of creator policy while removed targets remain inaccessible', async () => {
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await send('@goosy');
  expect(await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [B])).toMatchObject({
    rowCount: 0,
  });
  await rootFixture.db.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [
    A,
  ]);
  await rootFixture.phone.execute('sendRoomMessage', { roomId: R, text: '@hoots' }, P);
  expect(await commands(A)).toHaveLength(1);
});

it('deduplicates human writes, deliveries and final results', async () => {
  const messageId = id();
  for (let n = 0; n < 2; n++)
    await rootFixture.phone.execute('sendRoomMessage', { roomId: R, text: '@hoots', messageId }, H);
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2 AND state='pending'`,
        [messageId, A],
      )
    ).rowCount,
  ).toBe(1);
  const [c] = await commands();
  await claim(c!);
  const attempts = await Promise.allSettled(
    ['g2', 'g3'].map(async (generationId) =>
      startQueuedCommand(rootFixture.daemon, { roomId: R, commandId: c!.id }, A),
    ),
  );
  expect(attempts.every((a) => a.status === 'fulfilled')).toBe(true);
  const one = await result(c!, '@goosy Done');
  const two = await result(c!, '@goosy Done');
  expect(two.id).toBe(one.id);
  expect(await commands(B)).toHaveLength(1);
});

it('rejects unknown, wrong agent, cross-Room, completed and cancelled turn output without side effects', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const draft = { roomId: R, agentId: A, turnId: c!.turnRequestId, text: 'draft' };
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, turnId: id() }, A)).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, roomId: C }, A)).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', { ...draft, agentId: B }, B)).rejects.toThrow();
  await rootFixture.daemon.execute('postAgentDraft', draft, A);
  await rootFixture.phone.execute('cancelAgentTurn', { roomId: R, agentId: A, requestId: c!.turnRequestId }, H);
  await expect(result(c!, 'Stopped')).rejects.toThrow();
  await expect(rootFixture.daemon.execute('postAgentDraft', draft, A)).rejects.toThrow();
  expect(await commands()).toEqual([]);
  await send('@hoots next');
  const [next] = (await commands()).filter((c) => c.action === 'input');
  await claim(next!);
  await result(next!, 'Done');
  await rootFixture.daemon.execute('postAgentDraft', { ...draft, turnId: next!.turnRequestId }, A);
  expect(await commands()).toEqual([]);
});

it('routes a validated agent tag when the final message is committed', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  expect(await commands(B)).toEqual([]);
  await result(c!, '@goosy please help');
  expect(await commands(B)).toHaveLength(1);
});

it('routes the committed case-insensitive agent tag without a caller target list', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const posted = await result(c!, '@GOOSY please help');
  expect(await commands(B)).toHaveLength(1);
  // The indexed mention projection may retain the original spelling; the queue
  // records the addressed member without trusting a caller-supplied list.
  expect(
    (
      await rootFixture.db.query<{ tagged_ids: string[] }>(
        `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m WHERE m.id=$1`,
        [posted.id],
      )
    ).rows[0]?.tagged_ids,
  ).toEqual([]);
});

it('rolls final storage back if creating the next command fails', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await rootFixture.db.query(`CREATE FUNCTION refuse_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch failure'; END $$;
 CREATE TRIGGER refuse_command BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION refuse_command();`);
  try {
    await expect(result(c!, '@goosy Atomic')).rejects.toThrow('injected');
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text='Atomic'`)).rowCount).toBe(0);
  } finally {
    await rootFixture.db.query(
      `DROP TRIGGER refuse_command ON agent_commands; DROP FUNCTION refuse_command();`,
    );
  }
  await result(c!, '@goosy Atomic');
  expect(await commands(B)).toHaveLength(1);
});
