import { it, expect } from 'vitest';
import { sendMessage, replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage, readAgentCommands, type CommandRow } from './agent-command.js';
import { H, A, B, C, CHAT, THREAD, OTHER, db, daemon, queued } from './messaging.test-support.js';

it('Jellybean reports a card-feed-1118 blocker to Ruby’s addressed #beeline session', async () => {
  await db.query("UPDATE rooms SET name=CASE WHEN id=$1 THEN 'beeline' ELSE 'card-feed-1118' END WHERE id=ANY($2::uuid[])", [CHAT, [CHAT, THREAD]]);
  const sent = await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:A,place:CHAT}},text:'Thread work needs a decision'});
  expect(await queued()).toEqual([[A, CHAT]]);
  expect((await db.query('SELECT room_id FROM messages WHERE id=$1', [sent.id])).rows).toEqual([{ room_id: CHAT }]);
  const received = (await readAgentCommands(db, A)).commands[0]!;
  expect(received.from).toEqual({ agent: B, place: THREAD });
  expect((await db.query("SELECT message->'route'->'to' destination FROM agent_commands WHERE id=$1", [sent.id])).rows)
    .toEqual([{ destination: { agent: A, place: CHAT } }]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id=$2', [THREAD, B])).rows).toEqual([]);
});

it.each([false, true])('Nerd’s reply to Emberus’s avatar-background-color request returns to Emberus at #grunt; explicit=%s', async explicit => {
  await db.query("UPDATE rooms SET name=CASE WHEN id=$1 THEN 'grunt' ELSE 'avatar-background-color' END WHERE id=ANY($2::uuid[])", [CHAT, [CHAT, THREAD]]);
  const task = await sendMessage(db, {
    route: { from: { agent: A, place: CHAT }, to: { agent: C, place: THREAD } }, text: 'Review this PR',
  });
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1', [OTHER, CHAT]);
  if (explicit) await replyToMessage(db,C, { id: task.id, roomId: THREAD, text: 'PASS: reviewed the PR' });
  else await answerQueuedMessage(db, C, { roomId: THREAD, requestId: task.id, text: 'PASS: reviewed the PR' });
  expect(await queued()).toEqual([[A, CHAT]]);
  const replies = (await db.query('SELECT room_id FROM messages WHERE author_id=$1', [C])).rows;
  expect(replies).toEqual([{ room_id: explicit ? CHAT : THREAD }]);
});

it('person-facing messages and questions retain the owner’s chat address', async () => {
  const route = {from:{agent:B,place:THREAD},to:{agent:H,place:CHAT}};
  await sendMessage(db,{route,text:'The artifact is ready'});
  await sendMessage(db, {route, text: 'Choose the output',
    ask: { question: 'Which output?', options: ['Web', 'Phone'] },
  });
  expect((await db.query('SELECT room_id FROM messages WHERE author_id=$1 ORDER BY created_at,id', [B])).rows)
    .toEqual([{ room_id: CHAT }, { room_id: CHAT }]);
  expect((await db.query('SELECT room_id FROM room_choices')).rows).toEqual([{ room_id: CHAT }]);
});

it('a review request cannot reply after its recorded return chat closes', async () => {
  const task = await sendMessage(db, {
    route: { from: { agent: A, place: CHAT }, to: { agent: C, place: THREAD } }, text: 'Review this PR',
  });
  await db.query('UPDATE agent_commands SET return_room_id=$2 WHERE id=$1', [task.id, CHAT]);
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [CHAT]);
  await expect(replyToMessage(db,C, { roomId:THREAD, id: task.id, text: 'PASS: reviewed the PR' })).rejects.toThrow('archived');
  expect(await queued()).toEqual([[C,THREAD]]);
  expect((await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [task.id])).rows[0]!.state).toBe('pending');
});

it('replies to an owner request delivered in a thread keep the owner’s recorded chat', async () => {
  const task = await sendMessage(db, {
    route: { from: { agent: H, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Build widget',
  });
  await replyToMessage(db,B, { roomId:THREAD, id: task.id, text: 'Done' });
  expect((await db.query('SELECT room_id FROM messages WHERE author_id=$1', [B])).rows).toEqual([{ room_id: CHAT }]);
  expect(await queued()).toEqual([]);
});

it('refuses a normal completion message from a thread to a chat', async () => {
  await expect(daemon.execute('message', { roomId: THREAD, type: 'normal',
    address: `${A}@${CHAT}`, text: 'Done' }, B)).rejects.toThrow('thread agent session');
  expect(await queued()).toEqual([]);
});

it('routes a blocker after local completion to the assigning session, including the same agent in another place', async () => {
  const task = await sendMessage(db, {
    route: { from: { agent: B, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Build widget',
    parent: undefined,
  });
  await db.query(`INSERT INTO agent_commands(id,agent_id,room_id,reason,action,state,turn_request_id,root_command_id,root_source_message_id,agent_depth,private_payload)
    VALUES($1,$2,$3,'corner_objective','input','pending',$1,$1,$1,0,$4::jsonb)`, [task.id, B, THREAD,
    JSON.stringify({kind:'message',authorId:B,fromRoomId:CHAT,text:'Build widget',route:{from:{agent:B,place:CHAT},to:{agent:B,place:THREAD}}})]);
  await answerQueuedMessage(db, B, {roomId:THREAD, requestId:task.id, text:'Local work finished.'});
  await daemon.execute('message', {roomId:THREAD, type:'blocked', text:'The branch needs a decision.'}, B);
  expect(await queued()).toEqual([[B,CHAT]]);
});

it('keeps one open block and rings the human commander once for concurrent blocks without status words', async () => {
  const results = await Promise.allSettled(['Pick a branch.', 'Pick a target.'].map(text =>
    daemon.execute('message', {roomId:THREAD,type:'blocked',text}, B)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  expect((await db.query(`SELECT mark.identity_id FROM messages m JOIN needs_you_marks mark ON mark.message_id=m.id
    WHERE m.block_corner_id=$1 AND mark.cleared_at IS NULL`, [THREAD])).rows).toEqual([{identity_id:H}]);
  expect((await db.query(`SELECT id FROM messages WHERE block_corner_id=$1 AND ask_closed_reason IS NULL`, [THREAD])).rows)
    .toHaveLength(1);
});

it('a reply quotes its waking message and refuses another message before publishing', async () => {
  const task = await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}},text:'Review the change.'});
  await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:task.id,invocationId:crypto.randomUUID()},B);
  const input = {roomId:THREAD,requestId:task.id,type:'reply' as const,text:'I found a missing field.'};
  await expect(daemon.execute('message',{...input,quoteMsgId:'another'},B)).rejects.toThrow('woke this turn');
  const reply = await daemon.execute('message',{...input,quoteMsgId:task.id},B);
  expect((await db.query('SELECT room_id,reply_to_message_id FROM messages WHERE id=$1',[reply.id])).rows)
    .toEqual([{room_id:CHAT,reply_to_message_id:task.id}]);
});

it('a commander can pass a blocker to the person who assigned its own work', async () => {
  const assignment = await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:A,place:CHAT}},text:'Ship the change.'});
  await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:assignment.id,invocationId:'assignment'},A);
  const task = await daemon.execute('message',{type:'normal',roomId:CHAT,address:`${B}@${THREAD}`,text:'Build the change.'},A);
  await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:task.id,invocationId:'build'},B);
  const block = await daemon.execute('message',{type:'blocked',roomId:THREAD,text:'Which branch?'},B);
  await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:block.id,invocationId:'escalation'},A);
  const escalated = await daemon.execute('message',{type:'blocked',roomId:CHAT,text:'Please choose the branch.'},A);
  expect((await db.query('SELECT identity_id FROM needs_you_marks WHERE message_id=$1',[escalated.id])).rows)
    .toEqual([{identity_id:H}]);
});

it('returns a blocker to the sibling session assigning this task', async () => {
  await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}},text:'Open the project.'});
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const task = await daemon.execute('message',{type:'normal',roomId:OTHER,address:`${B}@${THREAD}`,text:'Compare the outputs.'},C);
  const block = await daemon.execute('message',{type:'blocked',roomId:THREAD,requestId:task.id,text:'Which version?'},B);
  expect((await db.query('SELECT agent_id,room_id FROM agent_commands WHERE id=$1',[block.id])).rows)
    .toEqual([{agent_id:C,room_id:OTHER}]);
});

it('exposes only typed messaging to helpers', async () => {
  const {DAEMON_OPERATION_NAMES} = await import('./daemon-service.js');
  for (const op of ['reply','report','order','postCornerMessage']) expect(DAEMON_OPERATION_NAMES.has(op as never)).toBe(false);
  for (const status of ['done','needs_decision']) {
    await expect(daemon.execute('report' as never,{roomId:THREAD,status,text:'Legacy'} as never,B)).rejects.toThrow();
  }
  await expect(daemon.execute('message',{roomId:THREAD,to:{agent:H,place:CHAT},text:'Legacy'} as never,B)).rejects.toThrow();
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1',[B])).rows).toEqual([]);
});

it('finishes a peer request silently after its typed reply and rejects the completed wake', async () => {
  const task = await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}},text:'Review this.'});
  await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:task.id,invocationId:crypto.randomUUID()},B);
  const reply = {roomId:THREAD,requestId:task.id,type:'reply' as const,quoteMsgId:task.id,text:'Reviewed.'};
  await daemon.execute('message',reply,B);
  await answerQueuedMessage(db,B,{roomId:THREAD,requestId:task.id,text:''});
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'complete'}]);
  await expect(daemon.execute('message',reply,B)).rejects.toThrow('woke this turn');
});

it('returns an explicit reply to the later sibling sender', async () => {
  await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}},text:'Build.'});
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const task = await sendMessage(db,{route:{from:{agent:C,place:OTHER},to:{agent:B,place:THREAD}},text:'Compare.'});
  const saved = await replyToMessage(db,B,{roomId:THREAD,id:task.id,text:'Compared.'});
  expect((await db.query('SELECT room_id,reply_to_message_id FROM messages WHERE id=$1',[saved.id])).rows)
    .toEqual([{room_id:OTHER,reply_to_message_id:task.id}]);
});

it('tracks a same-agent escalation separately in the assigning thread and replaces it on a newer block', async () => {
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const {insertCornerFacts} = await import('./test-support.js');
  await insertCornerFacts(db,{cornerId:OTHER,workerAgentId:B});
  const work = await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:OTHER}},text:'Build.'});
  const child = await daemon.execute('message',{type:'normal',roomId:OTHER,requestId:work.id,address:`${B}@${THREAD}`,text:'Review.'},B);
  const block = await daemon.execute('message',{type:'blocked',roomId:THREAD,requestId:child.id,text:'Need a branch.'},B);
  const input = {type:'blocked' as const,roomId:OTHER,requestId:block.id,text:'Which branch?'};
  const saved = await daemon.execute('message',input,B);
  expect((await db.query('SELECT block_corner_id,block_parent_id FROM messages WHERE id=$1',[saved.id])).rows)
    .toEqual([{block_corner_id:OTHER,block_parent_id:block.id}]);
  const replacement = await daemon.execute('message',{...input,text:'Which target branch?'},B);
  expect((await db.query('SELECT id FROM messages WHERE block_corner_id=$1 AND ask_closed_reason IS NULL',[OTHER])).rows)
    .toEqual([{id:replacement.id}]);
  expect((await db.query('SELECT ask_closed_reason,ask_closed_by FROM messages WHERE id=$1',[saved.id])).rows)
    .toEqual([{ask_closed_reason:`superseded by ${replacement.id}`,ask_closed_by:B}]);
});

it('replaces an open block on a second blocked message, closes the first with a note linking the new one, and notifies the commander once', async () => {
  // Agent commander: block -> block again -> one open block remains, first closed with note, commander wakes once for the new block.
  const task = await sendMessage(db, { route: { from: { agent: A, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Ship the fix.' });
  const first = await daemon.execute('message', { roomId: THREAD, requestId: task.id, type: 'blocked', text: 'Waiting on API credentials.' }, B);
  expect((await readAgentCommands(db, A, CHAT)).commands.map((c) => c.id)).toEqual([first.id]);
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [first.id]);

  const second = await daemon.execute('message', { roomId: THREAD, requestId: task.id, type: 'blocked', text: 'API credentials worked; now blocked on staging deploy.' }, B);
  expect(second.id).not.toBe(first.id);
  expect(second.receipt).toContain(`superseded previous block ${first.id!.slice(0, 8)}`);

  expect((await db.query('SELECT id FROM messages WHERE block_corner_id=$1 AND ask_closed_reason IS NULL', [THREAD])).rows)
    .toEqual([{ id: second.id }]);
  expect((await db.query('SELECT ask_closed_reason,ask_closed_by FROM messages WHERE id=$1', [first.id])).rows)
    .toEqual([{ ask_closed_reason: `superseded by ${second.id}`, ask_closed_by: B }]);
  // Commander receives exactly one new notification for the replacement block.
  expect((await readAgentCommands(db, A, CHAT)).commands.map((c) => c.id)).toEqual([second.id]);
});

it('replaces an open human-commander block after the first was answered via wakeBlockAnswer', async () => {
  const { wakeBlockAnswer } = await import('./implementer-blocks.js');
  const first = await daemon.execute('message', { roomId: THREAD, type: 'blocked', text: 'Need database password.' }, B);
  const replyId = '9'.repeat(64);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id) VALUES($1,$2,$3,'Added to vault.',$4)`,
    [replyId, CHAT, H, first.id],
  );
  const wake = await wakeBlockAnswer(db, replyId, CHAT, H);
  expect(wake).toBeDefined();

  const second = await daemon.execute(
    'message',
    { roomId: THREAD, requestId: wake!.turn_request_id, type: 'blocked', text: 'Database connected; now blocked on DNS record.' },
    B,
  );
  expect((await db.query('SELECT id,block_corner_id FROM messages WHERE block_corner_id=$1 AND ask_closed_reason IS NULL', [THREAD])).rows)
    .toEqual([{ id: second.id, block_corner_id: THREAD }]);
  expect((await db.query('SELECT ask_closed_reason,ask_closed_by FROM messages WHERE id=$1', [first.id])).rows)
    .toEqual([{ ask_closed_reason: `superseded by ${second.id}`, ask_closed_by: B }]);
  // Human commander has exactly one open Tasks mark, pointing to the new block.
  expect((await db.query('SELECT message_id,cleared_reason FROM needs_you_marks WHERE identity_id=$1 ORDER BY message_id', [H])).rows)
    .toEqual(
      [
        { message_id: first.id, cleared_reason: 'answered' },
        { message_id: second.id, cleared_reason: null },
      ].sort((a, b) => a.message_id!.localeCompare(b.message_id!)),
    );
});

it.each(['agent', 'human'] as const)('replaying an older blocked transport request keeps the current %s-commander blocker open', async commander => {
  const task = commander === 'agent'
    ? await sendMessage(db, { route: { from: { agent: A, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Ship the fix.' })
    : undefined;
  const firstInput = {
    roomId: THREAD,
    ...(task ? { requestId: task.id } : {}),
    type: 'blocked' as const,
    text: 'First blocker.',
    transportRequestId: `replay-first-${commander}`,
  };
  const secondInput = {
    roomId: THREAD,
    ...(task ? { requestId: task.id } : {}),
    type: 'blocked' as const,
    text: 'Second blocker.',
    transportRequestId: `replay-second-${commander}`,
  };
  const first = await daemon.execute('message', firstInput as never, B);
  const second = await daemon.execute('message', secondInput as never, B);
  const replayed = await daemon.execute('message', firstInput as never, B);

  expect(replayed.id).toBe(first.id);
  expect((await db.query('SELECT id FROM messages WHERE block_corner_id=$1 AND ask_closed_reason IS NULL', [THREAD])).rows)
    .toEqual([{ id: second.id }]);
  expect((await db.query('SELECT ask_closed_reason,ask_closed_by FROM messages WHERE id=$1', [first.id])).rows)
    .toEqual([{ ask_closed_reason: `superseded by ${second.id}`, ask_closed_by: B }]);
  expect((await db.query('SELECT ask_closed_reason FROM messages WHERE id=$1', [second.id])).rows)
    .toEqual([{ ask_closed_reason: null }]);
  if (commander === 'human') {
    expect((await db.query('SELECT message_id FROM needs_you_marks WHERE identity_id=$1 AND cleared_at IS NULL', [H])).rows)
      .toEqual([{ message_id: second.id }]);
  }
});

it('rings the blocker even when the same chat turn later posts local text', async () => {
  const {PushDeliveryLoop} = await import('./background.js');
  const {vi} = await import('vitest');
  await db.query("UPDATE identities SET push_level='full' WHERE id=$1",[H]);
  await db.query("INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('owner-device-token-12345678901234567890',$1,'android','physical')",[H]);
  const send = vi.fn().mockResolvedValue(undefined);
  const loop = new PushDeliveryLoop(db,{send});
  await loop.runOnce();
  const task = await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:CHAT}},text:'Ship.'});
  const block = await daemon.execute('message',{roomId:CHAT,requestId:task.id,type:'blocked',text:'Which branch?'},B);
  const final = await answerQueuedMessage(db,B,{roomId:CHAT,requestId:task.id,text:'I checked locally.'});
  await loop.runOnce();
  expect((await db.query('SELECT message_id FROM push_delivery_claims WHERE message_id=ANY($1::text[])',[[block.id,final.id]])).rows)
    .toEqual([{message_id:block.id}]);
});

it('Reproduction fb_638e1b93d94796a7f50188f0: wakes the commanding agent when a thread helper answers a peer message with normal turn text without ping-ponging', async () => {
  const delegated = await daemon.execute('message', {
    roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Audit slice 1 and report back.',
  }, A);
  const invocation = { id: crypto.randomUUID(), requestId: delegated.id };
  await daemon.execute('startAgentTurn', { roomId: THREAD, requestId: delegated.id, invocationId: invocation.id }, B);
  const report = 'Audit slice 1 complete: found two missing checks.';
  const final = await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: delegated.id, text: report, harnessEnded: true, invocation,
  }, B);
  expect(final.completed).toBe(true);
  // Retrying the same turn completion does not double-wake the commander.
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: delegated.id, text: report, harnessEnded: true, invocation,
  }, B);
  // Helper output stays a single public message in the thread with no duplicate agent-command pill.
  expect((await db.query('SELECT room_id,presentation,text FROM messages WHERE author_id=$1', [B])).rows)
    .toEqual([{ room_id: THREAD, presentation: 'message', text: report }]);
  const wakes = (await readAgentCommands(db, A, THREAD)).commands;
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    reason: 'reply',
    roomId: THREAD,
    from: { agent: B, place: THREAD },
    source: { body: report },
  });
  // Commander synthesizes with normal turn text: never wakes the helper back (no ping-pong).
  const synthInvocation = { id: crypto.randomUUID(), requestId: wakes[0]!.id };
  await daemon.execute('startAgentTurn', { roomId: THREAD, requestId: wakes[0]!.id, invocationId: synthInvocation.id }, A);
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: wakes[0]!.id, text: 'Synthesized audit report ready.', harnessEnded: true, invocation: synthInvocation,
  }, A);
  expect(await queued()).toEqual([]);
});

it.each(['reply', 'normal', 'blocked', 'mention'] as const)('avoids double-waking the commander on thread peer turn completion (%s)', async mode => {
  const delegated = await daemon.execute('message', {
    roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Inspect module.',
  }, A);
  const invocation = { id: crypto.randomUUID(), requestId: delegated.id };
  await daemon.execute('startAgentTurn', { roomId: THREAD, requestId: delegated.id, invocationId: invocation.id }, B);
  if (mode === 'reply') {
    await daemon.execute('message', { roomId: THREAD, requestId: delegated.id, type: 'reply', quoteMsgId: delegated.id, text: 'Explicit reply report.' }, B);
  } else if (mode === 'normal') {
    await daemon.execute('message', { roomId: THREAD, requestId: delegated.id, type: 'normal', address: `${A}@${THREAD}`, text: 'Direct message report.' }, B);
  } else if (mode === 'blocked') {
    await daemon.execute('message', { roomId: THREAD, requestId: delegated.id, type: 'blocked', text: 'Need credentials.' }, B);
  }
  const closingText = mode === 'mention' ? '@ruby Here is the audit report.' : 'Closing turn note.';
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: delegated.id, text: closingText, harnessEnded: true, invocation,
  }, B);
  expect((await readAgentCommands(db, A, THREAD)).commands).toHaveLength(1);
});

it('deduplicates auto-wake across batched peer messages from the same sender and lets the commander close silently', async () => {
  const first = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part A.' }, A);
  const second = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part B.' }, A);
  const invocation = { id: crypto.randomUUID(), requestId: first.id };
  await daemon.execute('startAgentTurn', {
    roomId: THREAD, requestId: first.id, invocationId: invocation.id, batchedCommandIds: [second.id],
  }, B);
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: first.id, queuedRequestIds: [second.id], text: 'Both parts checked.', harnessEnded: true, invocation,
  }, B);
  const wakes = (await readAgentCommands(db, A, THREAD)).commands;
  expect(wakes).toHaveLength(1);
  // Informational reply allows the commander to end silently while waiting on another helper.
  const silent = await answerQueuedMessage(db, A, { roomId: THREAD, requestId: wakes[0]!.id, text: '', harnessEnded: true });
  expect(silent.completed).toBe(true);
  expect(await queued()).toEqual([]);
});

it.each(['first', 'second'] as const)('avoids double-waking a commander when a batched turn explicitly replies to the %s request before posting closing text', async repliedWhich => {
  const first = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part A.' }, A);
  const second = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part B.' }, A);
  const otherCommander = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part C.' }, C);
  const invocation = { id: crypto.randomUUID(), requestId: first.id };
  await daemon.execute('startAgentTurn', {
    roomId: THREAD, requestId: first.id, invocationId: invocation.id, batchedCommandIds: [second.id, otherCommander.id],
  }, B);
  const target = repliedWhich === 'first' ? first : second;
  await daemon.execute('message', {
    roomId: THREAD, requestId: first.id, type: 'reply', quoteMsgId: target.id, text: 'Explicit reply covering both parts.',
  }, B);
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: first.id, queuedRequestIds: [second.id, otherCommander.id], text: 'Closing summary for the batch.', harnessEnded: true, invocation,
  }, B);
  expect((await readAgentCommands(db, A, THREAD)).commands).toHaveLength(1);
  // Another commander in the same batch who did not receive an explicit reply still wakes once.
  expect((await readAgentCommands(db, C, THREAD)).commands).toHaveLength(1);
});

it('avoids double-waking a commander when an earlier batched request already completed via explicit reply before closing text posts for the remaining item', async () => {
  const first = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part A.' }, A);
  const second = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part B.' }, A);
  const invocation = { id: crypto.randomUUID(), requestId: first.id };
  await daemon.execute('startAgentTurn', {
    roomId: THREAD, requestId: first.id, invocationId: invocation.id, batchedCommandIds: [second.id],
  }, B);
  await replyToMessage(db, B, { roomId: THREAD, id: first.id, text: 'Explicit reply for both parts.', invocation });
  // Runner omits the already-completed first item from queuedRequestIds when posting closing text for second.
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: second.id, text: 'Closing summary.', harnessEnded: true, invocation,
  }, B);
  expect((await readAgentCommands(db, A, THREAD)).commands).toHaveLength(1);
});

it('wakes the commander when a fresh invocation completes a remaining request after an earlier batched invocation was interrupted', async () => {
  const first = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part A.' }, A);
  const second = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Check part B.' }, A);
  const firstInvocation = { id: crypto.randomUUID(), requestId: first.id };
  await daemon.execute('startAgentTurn', {
    roomId: THREAD, requestId: first.id, invocationId: firstInvocation.id, batchedCommandIds: [second.id],
  }, B);
  await replyToMessage(db, B, { roomId: THREAD, id: first.id, text: 'Part A done.', invocation: firstInvocation });
  // Turn ends/interrupts before answering second; first wake is handled and second stays pending.
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: second.id, text: '', harnessEnded: true, invocation: firstInvocation,
  }, B);
  const firstWake = (await readAgentCommands(db, A, THREAD)).commands;
  expect(firstWake).toHaveLength(1);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [second.id])).rows).toEqual([{ state: 'pending' }]);
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1", [firstWake[0]!.id]);

  // A fresh invocation completes the remaining pending request and must wake the commander.
  const freshInvocation = { id: crypto.randomUUID(), requestId: second.id };
  await daemon.execute('startAgentTurn', {
    roomId: THREAD, requestId: second.id, invocationId: freshInvocation.id,
  }, B);
  await daemon.execute('postRoomMessage', {
    roomId: THREAD, requestId: second.id, text: 'Part B done.', harnessEnded: true, invocation: freshInvocation,
  }, B);
  const freshWakes = (await readAgentCommands(db, A, THREAD)).commands;
  expect(freshWakes).toHaveLength(1);
  expect(freshWakes[0]).toMatchObject({ reason: 'reply', source: { body: 'Part B done.' } });
});

it('does not wake on empty helper turns or review-context repair turns, and wakes on hosted helper failure', async () => {
  // Silent empty turn stays owed without waking commander with empty noise.
  const silentTask = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'Audit slice.' }, A);
  const empty = await daemon.execute('postRoomMessage', { roomId: THREAD, requestId: silentTask.id, text: '', harnessEnded: true }, B);
  expect(empty.answered).toBe(false);
  expect((await readAgentCommands(db, A, THREAD)).commands).toEqual([]);

  // Hosted failure completes the helper command and wakes the waiting commander with the reason.
  const { failHostedAgentTurn } = await import('./agent-turn-end.js');
  const row = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [silentTask.id])).rows[0]!;
  await db.transaction(tx => failHostedAgentTurn(tx, row, B, 'Model quota exhausted'));
  const failWakes = (await readAgentCommands(db, A, THREAD)).commands;
  expect(failWakes).toHaveLength(1);
  expect(failWakes[0]).toMatchObject({ reason: 'reply', source: { body: 'Jellybean failed to answer: Model quota exhausted' } });
  await db.query("UPDATE agent_commands SET state='complete' WHERE state='pending'");

  // Review/repair messages carrying review_context stay governed by corner lifecycle, not peer auto-wake.
  const repair = await daemon.execute('message', { roomId: THREAD, type: 'normal', address: `${B}@${THREAD}`, text: 'FAIL: fix test.' }, C);
  await db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`, [
    repair.id, JSON.stringify({ cornerId: THREAD, headSha: 'a'.repeat(40), pullRequest: 7, briefRevision: 1, purpose: 'repair' }),
  ]);
  await daemon.execute('postRoomMessage', { roomId: THREAD, requestId: repair.id, text: 'Pushed fix, waiting for checks.', harnessEnded: true }, B);
  expect((await readAgentCommands(db, C, THREAD)).commands).toEqual([]);
});
