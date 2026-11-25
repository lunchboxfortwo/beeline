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
  expect(await queued()).toEqual(explicit ? [[A, CHAT]] : []);
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

it('rings the human commander once for concurrent blocks without status words', async () => {
  const results = await Promise.allSettled(['Pick a branch.', 'Pick a target.'].map(text =>
    daemon.execute('message', {roomId:THREAD,type:'blocked',text}, B)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await db.query(`SELECT mark.identity_id FROM messages m JOIN needs_you_marks mark ON mark.message_id=m.id
    WHERE m.block_corner_id=$1 AND mark.cleared_at IS NULL`, [THREAD])).rows).toEqual([{identity_id:H}]);
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
  const task = await daemon.execute('message',{type:'normal',roomId:CHAT,requestId:assignment.id,address:`${B}@${THREAD}`,text:'Build the change.'},A);
  const block = await daemon.execute('message',{type:'blocked',roomId:THREAD,requestId:task.id,text:'Which branch?'},B);
  const escalated = await daemon.execute('message',{type:'blocked',roomId:CHAT,requestId:block.id,text:'Please choose the branch.'},A);
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

it('tracks a same-agent escalation separately in the assigning thread', async () => {
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
  await expect(daemon.execute('message',input,B)).rejects.toThrow('open block');
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
