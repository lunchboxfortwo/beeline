import { it, expect } from 'vitest';
import { sendMessage } from './agent-messaging.js';
import { answerQueuedMessage, readAgentCommands, type CommandRow } from './agent-command.js';
import { H, A, B, C, CHAT, THREAD, OTHER, db, daemon, queued } from './messaging.test-support.js';

it('Jellybean reports a card-feed-1118 blocker to Ruby’s addressed #beeline session', async () => {
  await db.query("UPDATE rooms SET name=CASE WHEN id=$1 THEN 'beeline' ELSE 'card-feed-1118' END WHERE id=ANY($2::uuid[])", [CHAT, [CHAT, THREAD]]);
  const sent = await daemon.execute('message', {
    roomId: THREAD, to: { agent: A, place: CHAT }, text: 'blocked: thread work needs a decision',
  }, B);
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
  if (explicit) await daemon.execute('reply', { id: task.id, roomId: THREAD, text: 'PASS: reviewed the PR' }, C);
  else await answerQueuedMessage(db, C, { roomId: THREAD, requestId: task.id, text: 'PASS: reviewed the PR' });
  expect(await queued()).toEqual(explicit ? [[A, CHAT]] : []);
  const replies = (await db.query('SELECT room_id FROM messages WHERE author_id=$1', [C])).rows;
  expect(replies).toEqual([{ room_id: explicit ? CHAT : THREAD }]);
});

it('person-facing messages and questions retain the owner’s chat address', async () => {
  await daemon.execute('message', { roomId: THREAD, to: { agent: H, place: CHAT }, text: 'The artifact is ready' }, B);
  await daemon.execute('message', {
    roomId: THREAD, to: { agent: H, place: CHAT }, text: 'Choose the output',
    ask: { question: 'Which output?', options: ['Web', 'Phone'] },
  }, B);
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
  await daemon.execute('reply', { roomId:THREAD, id: task.id, text: 'PASS: reviewed the PR' }, C);
  expect(await queued()).toEqual([]);
  expect((await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [task.id])).rows[0]!.state).toBe('cancelled');
});

it('replies to an owner request delivered in a thread keep the owner’s recorded chat', async () => {
  const task = await sendMessage(db, {
    route: { from: { agent: H, place: CHAT }, to: { agent: B, place: THREAD } }, text: 'Build widget',
  });
  await daemon.execute('reply', { roomId:THREAD, id: task.id, text: 'Done' }, B);
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
