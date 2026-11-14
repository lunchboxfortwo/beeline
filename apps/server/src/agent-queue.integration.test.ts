import { afterAll,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { AGENT_COMMAND_SCHEMA,answerQueuedMessage,createAgentCommand,queueMessage,readAgentCommands } from './agent-command.js';
import { isAgentCommand } from '@beeline/api-contract/daemon';
import { RETIRED_STOP_CONTROLS } from './agent-turn-end.js';
import { claimAgentConnection,releaseAgentConnection } from './connection-presence.js';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { migratedDatabase,type PgliteDatabase } from './test-support.js';

const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R1 = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, live: LiveHub;
let sequence = 0;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent')`, [H, A]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queue')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'One'),($2,$3,'Two')`, [R1, R2, W]);
  for (const who of [H, A]) for (const room of [null, R1, R2])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W, room, who]);
  live = new LiveHub();
  daemon = new DaemonService(db, live);
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM agent_turns');
});

/** A person tags the agent in a Room: one queue item. */
async function ask(roomId: string, text: string) {
  const id = `m${String(++sequence).padStart(63, '0')}`;
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
    VALUES($1,$2,$3,$4,'message',now())`, [id, roomId, H, `@agent ${text}`]);
  return (await createAgentCommand(db, { roomId, agentId: A, sourceMessageId: id, reason: 'human_tag' }))!;
}
const queue = async () => (await daemon.execute('getAgentCommands', {}, A)).commands;
const answer = (roomId: string, requestId: string, text: string) =>
  daemon.execute('postRoomMessage', { roomId, requestId, text, presentation: 'message' }, A);

it('one queue per agent: items from every place, oldest first, with where the answer goes', async () => {
  const first = await ask(R2, 'first');
  const second = await ask(R1, 'second');
  const items = await queue();
  expect(items.map(item => [item.id, item.roomId, item.returnRoomId])).toEqual([
    [first.id, R2, R2], [second.id, R1, R1]]);
  expect(items[0]!.source.body).toContain('first');
});

it('an item stays queued until its answer is posted, then the answer is idempotent', async () => {
  const item = await ask(R1, 'hello');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  const posted = await answer(R1, item.turn_request_id, 'hi there');
  expect(await queue()).toEqual([]);
  const resent = await answer(R1, item.turn_request_id, 'hi there');
  expect(resent.id).toBe(posted.id);
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,
    [A, item.turn_request_id])).rows[0]).toEqual({ n: 1 });
  expect((await db.query(`SELECT state,result_message_id FROM agent_commands WHERE id=$1`, [item.id])).rows[0])
    .toEqual({ state: 'complete', result_message_id: posted.id });
});

it('a dropped helper leaves the item queued for its next registration', async () => {
  const item = await ask(R1, 'still there?');
  await claimAgentConnection(db, live, A, {}, { connectionId: 'one', instanceId: 'server' });
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  await releaseAgentConnection(db, live, A, 'one');
  await claimAgentConnection(db, live, A, {}, { connectionId: 'two', instanceId: 'server' });
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
});

it('upgrades a legacy resume sharing its parent source without losing either answer obligation', async () => {
  const parent = await ask(R1, 'answer both items');
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,
    action,reason,root_command_id,parent_command_id,root_source_message_id,agent_depth,state)
    SELECT 'legacy-resume',room_id,agent_id,source_message_id,turn_request_id,'resume','resume',
      root_command_id,id,root_source_message_id,agent_depth,'pending' FROM agent_commands WHERE id=$1`, [parent.id]);
  await db.query(AGENT_COMMAND_SCHEMA);
  const items = await queue();
  expect(items.map(item=>[item.id,item.turnRequestId])).toEqual([
    [parent.id,parent.turn_request_id],['legacy-resume','legacy-resume']]);
  expect(items[1]!.source.body).toContain('answer both items');
  await answer(R1,parent.turn_request_id,'First answer');
  expect((await queue()).map(item=>item.id)).toEqual(['legacy-resume']);
  await answer(R1,'legacy-resume','Resume answer');
  expect(await queue()).toEqual([]);
});

it('retires a surviving legacy corner-close stop instead of delivering it as work', async () => {
  const parent = await ask(R1, 'original human order');
  await db.query(`UPDATE agent_commands SET state='cancelled',cancellation_reason='corner_close' WHERE id=$1`, [parent.id]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
    root_command_id,parent_command_id,root_source_message_id,agent_depth,state,private_payload)
    VALUES('legacy-stop',$1,$2,NULL,'legacy-stop','stop','corner_close',$3,$3,$4,0,'pending',$5::jsonb)`,
    [R2, A, parent.id, parent.source_message_id,
      JSON.stringify({ kind:'lifecycle',text:'@GitHub passed a check',authorId:H,fromRoomId:R2 })]);
  const live = await ask(R2, 'still owed');
  await db.query(AGENT_COMMAND_SCHEMA);
  await db.query(RETIRED_STOP_CONTROLS);
  expect((await queue()).map(item => item.id)).toEqual([live.id]);
  expect((await db.query(`SELECT state,cancellation_reason,result_message_id FROM agent_commands WHERE id='legacy-stop'`)).rows[0])
    .toEqual({ state:'cancelled',cancellation_reason:'corner_close',result_message_id:null });
  expect(isAgentCommand({ ...(await queue())[0], action:'stop' })).toBe(false);
});

it('Stop cancels the item: it leaves the queue and its answer is refused', async () => {
  const item = await ask(R1, 'long job');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id }, A);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('stop-source',$1,$2,'stop','message')`, [R1, H]);
  const phone = new (await import('./phone-service.js')).PhoneService(db, 'http://test');
  await phone.cancelAgentTurn({ roomId: R1, agentId: A, requestId: item.turn_request_id }, H);
  expect(await queue()).toEqual([]);
  await expect(answer(R1, item.turn_request_id, 'too late')).rejects.toThrow('command turn cancelled');
});

it('empty output and silence acknowledgements leave an unanswered request queued', async () => {
  const item = await ask(R1, 'anything?');
  expect(await daemon.execute('postCornerMessage', {roomId:R1,cornerId:R1,requestId:item.turn_request_id,
    text:'<thinking>private reasoning</thinking>'},A)).toMatchObject({stored:false,visible:false});
  await answer(R1, item.turn_request_id, '<thinking>nothing to say</thinking>');
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,
    [A, item.turn_request_id])).rows[0]).toEqual({ n: 0 });
  expect(await daemon.execute('markAgentTurnSilent', { roomId: R1, requestId: item.turn_request_id }, A)).toMatchObject({ answered: false });
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  await answer(R1, item.turn_request_id, 'Here is my answer.');
  expect(await queue()).toEqual([]);
});

it('posts a private answer to the return address fixed at insertion, then completes the item', async () => {
  const item = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'answer in Two', authorId: H, fromRoomId: R2 } });
  expect((await queue()).find(entry => entry.id === item!.id)?.returnRoomId).toBe(R2);
  // A later mutable context must not move the committed return address.
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(jsonb_set(private_payload,'{fromRoomId}',to_jsonb($2::text)),'{authorId}',to_jsonb($3::text))
    WHERE id=$1`, [item!.id, R1, A]);
  await answer(R1, item!.turn_request_id, 'recorded-route answer');
  expect((await db.query('SELECT room_id,text FROM messages WHERE author_id=$1 AND text=$2', [A, 'recorded-route answer'])).rows)
    .toEqual([{ room_id: R2, text: 'recorded-route answer' }]);
  expect(await queue()).toEqual([]);
  await answer(R1, item!.turn_request_id, 'recorded-route answer');
  expect((await db.query('SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2', [A, 'recorded-route answer'])).rows[0])
    .toEqual({ n: 1 });
});

it('retains the answer obligation when return membership is gone, with no public fallback', async () => {
  const item = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', text: 'private question', authorId: H, fromRoomId: R2 } });
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R2, H]);
  try {
    await expect(answer(R1, item!.turn_request_id, 'private answer')).rejects.toThrow('return address');
    expect((await queue()).map(entry => entry.id)).toContain(item!.id);
    expect((await db.query('SELECT 1 FROM messages WHERE author_id=$1 AND text=$2', [A, 'private answer'])).rows).toEqual([]);
  } finally {
    await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2', [R2, H]);
  }
});

it('queues messages beyond the retired chain-depth cap', async () => {
  const parent = await ask(R1, 'root');
  await db.query('UPDATE agent_commands SET agent_depth=50 WHERE id=$1', [parent.id]);
  const next = await createAgentCommand(db, { roomId: R1, agentId: A, sourceMessageId: null, reason: 'order',
    parent: { ...parent, agent_depth: 50 }, privatePayload: { kind: 'order', text: 'next request', authorId: H, fromRoomId: R1 } });
  expect(next!.agent_depth).toBe(51);
  expect((await queue()).map(entry => entry.id)).toEqual([parent.id, next!.id]);
});

it('drops malformed optional tool history without losing the answer', async () => {
  const item = await ask(R1, 'answer despite broken history');
  await daemon.execute('postRoomMessage', { roomId: R1, requestId: item.turn_request_id,
    text: 'answer without history', steps: [{ kind: 'unsupported' }] as never }, A);
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT text FROM messages WHERE author_id=$1 AND request_id=$2', [A, item.turn_request_id])).rows)
    .toEqual([{ text: 'answer without history' }]);
});

it('shows only the offline connection notice when the harness cannot start, keeping its item queued', async () => {
  const item = await ask(R1, 'waiting for a harness');
  await daemon.execute('startAgentTurn', { roomId: R1, requestId: item.turn_request_id, available: false }, A);
  expect((await queue()).map(entry => entry.id)).toEqual([item.id]);
  const notices = await db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND presentation='system'`, [R1]);
  expect(notices.rows.at(-1)?.text).toMatch(/is offline.*connect again/);
  expect((await db.query('SELECT state,completed_at FROM agent_commands WHERE id=$1', [item.id])).rows[0])
    .toEqual({ state: 'pending', completed_at: null });
});

it('an unresolved offline-notice read cannot hold intake or the answer', async () => {
  const phone = new (await import('./phone-service.js')).PhoneService(db, 'http://test');
  const original = db.query.bind(db);
  let resume!: () => void, observed = false;
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(db, 'query').mockImplementation(async (sql, values) => {
    if (sql === "SELECT 1 FROM identities WHERE id=$1 AND kind='human'") {
      observed = true;
      await waiting;
    }
    return original(sql, values);
  });
  try {
    await phone.execute('sendRoomMessage', { roomId: R1, text: '@agent answer before the notice read finishes' }, H);
    expect(observed).toBe(true);
    const [item] = await queue();
    await answer(R1, item!.id, 'The answer is already posted.');
    expect(await queue()).toEqual([]);
  } finally {
    resume();
    spy.mockRestore();
    await db.backgroundWork.drain();
  }
});

it('a missing optional human reply link still appends and answers the request', async () => {
  const phone = new (await import('./phone-service.js')).PhoneService(db, 'http://test');
  const id = 'e'.repeat(64);
  await phone.sendReply({ roomId: R1, parentMessageId: 'f'.repeat(64), messageId: id, text: '@agent answer without the missing parent' }, H);
  const items = await queue();
  expect(items).toHaveLength(1);
  expect(items[0]?.source.body).toContain('answer without the missing parent');
  await answer(R1, items[0]!.turnRequestId, 'Here is the answer.');
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT reply_to_message_id FROM messages WHERE id=$1', [id])).rows[0]).toEqual({ reply_to_message_id: null });
});

it('uses one membership snapshot at the shared entry and one at the answer exit', async () => {
  const reads: string[] = [];
  const observe = (database: SqlDatabase): SqlDatabase => new Proxy(database, {
    get(target, key) {
      if (key === 'transaction') return (work: (tx: SqlDatabase) => Promise<unknown>) => target.transaction(tx => work(observe(tx)));
      if (key === 'query') return (sql: string, values?: unknown[]) => {
        if (sql.includes('memberships')) reads.push(sql);
        return target.query(sql, values);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const observed = observe(db);
  const sent = await queueMessage(observed, { kind: 'post', roomId: R1, authorId: H, text: '@agent one entry' });
  expect(sent.commands).toHaveLength(1);
  expect(reads).toHaveLength(1);
  const item = sent.commands[0]!;
  reads.length = 0;
  await readAgentCommands(observed, A);
  expect(reads).toHaveLength(0);
  await answerQueuedMessage(observed, A, { roomId: R1, requestId: item.turn_request_id, text: 'one exit' });
  expect(reads).toHaveLength(1);
  expect(await queue()).toEqual([]);
});

it('delivers the queued source despite transcript edits and an optional workflow read failure', async () => {
  const item = await ask(R1, 'Keep the original request');
  await db.query('UPDATE messages SET text=$2 WHERE id=$1', [item.source_message_id, 'Later edited context']);
  const query = db.query.bind(db);
  const unavailable = new Proxy(db, {
    get(target, key) {
      if (key === 'query') return (sql: string, values?: unknown[]) => {
        if (/workspace_skills|workspace_skill_versions|room_choices|voice_orders/.test(sql))
          throw new Error('optional context is unavailable');
        return query(sql, values);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect((await readAgentCommands(unavailable, A)).commands[0]?.source.body).toContain('Keep the original request');
  await answer(R1, item.turn_request_id, 'The original request was answered.');
  expect(await queue()).toEqual([]);
});

it('normalizes unrepresentable text without refusing the message or truncating its answer', async () => {
  const sent = await queueMessage(db, { kind: 'post', roomId: R1, authorId: H, text: '@agent NUL\0 and surrogate \uD800' });
  expect((await queue())[0]?.source.body).toBe('@agent NUL\uFFFD and surrogate \uFFFD');
  const text = 'A complete answer. '.repeat(8_000);
  const saved = await answer(R1, sent.commands[0]!.turn_request_id, text);
  expect((await db.query('SELECT text FROM messages WHERE id=$1', [saved.id])).rows[0]?.text).toBe(text.trim());
});

it('keeps closing text in activity when a reply tool already answered this request', async () => {
  const item = await ask(R1, 'Publish one reply');
  const posted = await daemon.execute('postCornerMessage', { roomId: R1, cornerId: R1,
    requestId: item.turn_request_id, text: 'The reply from the tool.' }, A);
  const settled = await answer(R1, item.turn_request_id, 'Closing details belong in activity.');
  expect((await db.query("SELECT id,text FROM messages WHERE request_id=$1 AND author_id=$2 AND presentation='message'",
    [item.turn_request_id,A])).rows).toEqual([{id:posted.id,text:'The reply from the tool.'}]);
  expect(settled.id).toBe(posted.id);
  expect((await db.query('SELECT result_message_id FROM agent_commands WHERE id=$1',[item.id])).rows[0]?.result_message_id).toBe(posted.id);
  expect((await db.query("SELECT activity FROM messages WHERE request_id=$1 AND presentation='activity'", [item.id])).rows[0]?.activity)
    .toContainEqual({kind:'note',title:'Turn summary',text:'Closing details belong in activity.'});
  expect((await answer(R1,item.turn_request_id,'Closing details belong in activity.')).id).toBe(settled.id);
  expect(await queue()).toEqual([]);
});

it('publishes the closing text as the answer when no reply tool posted', async () => {
  const item = await ask(R1, 'Use the closing answer');
  const settled = await answer(R1,item.turn_request_id,'This closing text is the answer.');
  expect((await db.query("SELECT id,text,presentation FROM messages WHERE request_id=$1 AND author_id=$2",
    [item.turn_request_id,A])).rows).toEqual([{id:settled.id,text:'This closing text is the answer.',presentation:'message'}]);
  expect(await queue()).toEqual([]);
});


it('distinct requests using the same source retain separate item and answer identities',async()=>{
  const first=await ask(R1,'answer all three causes');
  const second=(await createAgentCommand(db,{id:'separate-cause-one',roomId:R1,agentId:A,
    sourceMessageId:first.source_message_id,reason:'subscribed_event'}))!;
  const third=(await createAgentCommand(db,{id:'separate-cause-two',roomId:R1,agentId:A,
    sourceMessageId:first.source_message_id,reason:'subscribed_event'}))!;
  expect(new Set((await queue()).map(item=>item.turnRequestId)).size).toBe(3);
  for(const item of [first,second,third]) await answer(R1,item.turn_request_id,`Answered ${item.id}`);
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=ANY($2::text[])',
    [A,[first.turn_request_id,second.turn_request_id,third.turn_request_id]])).rows[0]).toEqual({n:3});
});

it('a late attachment must reach the existing reply before its item can finish',async()=>{
  const item=await ask(R1,'send the proof');
  const posted=await daemon.execute('postCornerMessage',{roomId:R1,cornerId:R1,requestId:item.turn_request_id,text:'The proof is ready.'},A);
  const file={url:'https://example.test/late-proof',name:'proof.txt',mimeType:'text/plain',size:10};
  await db.query('UPDATE agent_commands SET answer_attachments=$2::jsonb WHERE id=$1',[item.id,JSON.stringify([file])]);
  await db.query(`CREATE FUNCTION refuse_late_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${posted.id}' THEN RAISE EXCEPTION 'late proof write failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER refuse_late_proof BEFORE UPDATE OF attachments ON messages FOR EACH ROW EXECUTE FUNCTION refuse_late_proof()`);
  try { await expect(answer(R1,item.turn_request_id,'Closing summary')).rejects.toThrow('late proof write failed'); }
  finally { await db.query('DROP TRIGGER refuse_late_proof ON messages;DROP FUNCTION refuse_late_proof()'); }
  expect((await queue()).map(item=>item.id)).toContain(item.id);
  await answer(R1,item.turn_request_id,'Closing summary');
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT attachments FROM messages WHERE id=$1',[posted.id])).rows[0]).toEqual({attachments:[file]});
  expect((await db.query("SELECT count(*)::int n FROM messages WHERE request_id=$1 AND author_id=$2 AND presentation='message'",[item.turn_request_id,A])).rows[0]).toEqual({n:1});
});


it('optional question formatting cannot make PostgreSQL reject the answer',async()=>{
  const item=await ask(R1,'choose a scope');
  const posted=await answerQueuedMessage(db,A,{roomId:R1,requestId:item.turn_request_id,
    report:true,status:'needs_decision',text:'Choose the scope?',ask:'Which scope?\u0000\ud800'});
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT card FROM messages WHERE id=$1',[posted.id])).rows[0]).toMatchObject({card:{ask:'Which scope?\uFFFD\uFFFD'}});
});

it('gives same-source obligations distinct item-owned answer identities by default', async () => {
  const first=await ask(R1,'one source with two obligations');
  const second=(await createAgentCommand(db,{roomId:R1,agentId:A,
    sourceMessageId:first.source_message_id,reason:'subscribed_event'}))!;
  expect(first.turn_request_id).toBe(first.id);
  expect(second.turn_request_id).toBe(second.id);
  expect(second.id).not.toBe(first.id);
  const posted=await answer(R1,second.id,'Answer to the second item');
  expect((await queue()).map(item=>item.id)).toEqual([first.id]);
  expect((await answer(R1,second.id,'Replay')).id).toBe(posted.id);
  expect((await queue()).map(item=>item.id)).toEqual([first.id]);
  await answer(R1,first.id,'Answer to the first item');
  expect(await queue()).toEqual([]);
});

it('keeps an 18-hour offline backlog pending until one combined answer completes all 28 items', async () => {
  await claimAgentConnection(db, live, A, {}, { connectionId: 'before-offline', instanceId: 'server' });
  await releaseAgentConnection(db, live, A, 'before-offline');
  await db.query(`UPDATE agent_connections SET released_at=clock_timestamp()-interval '18 hours' WHERE agent_id=$1`, [A]);
  const tags = [];
  for (let n = 1; n <= 3; n++) tags.push(await ask(R1, `question ${n}`));
  const runs = [];
  for (let n = 0; n < 25; n++) {
    const source = `offline-schedule-${n}`;
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
      VALUES($1,$2,$3,$4,'system',$5::jsonb)`, [source,R1,H,`scheduled run ${n}`,
        JSON.stringify({ kind:'schedule-ran',scheduleId:'daily-check',consequence:`scheduled run ${n}` })]);
    runs.push((await createAgentCommand(db, { roomId:R1,agentId:A,sourceMessageId:source,reason:'schedule' }))!);
  }
  await claimAgentConnection(db, live, A, {}, { connectionId: 'after-offline', instanceId: 'server' });
  const items = await queue();
  expect(items).toHaveLength(28);
  expect(items.every(item => item.offlineSeconds !== undefined)).toBe(true);
  expect(items[0]!.offlineSeconds! / 3600).toBeCloseTo(18, 1);
  expect(items.filter(item => item.scheduleId === 'daily-check')).toHaveLength(25);
  const pending = await db.query(`SELECT count(*)::int n FROM agent_commands WHERE state='pending'`);
  expect(pending.rows[0]).toEqual({ n:28 });
  const input = { roomId:R1,requestId:items[0]!.id,queuedRequestIds:items.slice(1).map(item => item.id),
    text:'Answers to all three questions and the latest scheduled run.' };
  const posted = await daemon.execute('postRoomMessage', input, A);
  expect(await queue()).toEqual([]);
  expect((await db.query(`SELECT count(*)::int n FROM agent_commands WHERE state='complete' AND result_message_id=$1`, [posted.id])).rows[0])
    .toEqual({ n:28 });
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2`, [A,input.text])).rows[0])
    .toEqual({ n:1 });
  expect((await daemon.execute('postRoomMessage',input,A)).id).toBe(posted.id);
  expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND text=$2`, [A,input.text])).rows[0])
    .toEqual({ n:1 });
  // New live inputs belong to their own turn, without the stale-work note.
  const fresh = await ask(R1,'live input');
  expect((await queue()).find(item => item.id === fresh.id)?.offlineSeconds).toBeUndefined();
});

it('publishes a combined answer to each recorded return address', async () => {
  const first = await ask(R1,'answer here');
  const second = (await createAgentCommand(db, { roomId:R1,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',text:'answer in Two',authorId:H,fromRoomId:R2} }))!;
  await daemon.execute('postRoomMessage', {roomId:R1,requestId:first.id,queuedRequestIds:[second.id],text:'Both answers'}, A);
  expect(await queue()).toEqual([]);
  expect((await db.query(`SELECT room_id FROM messages WHERE author_id=$1 AND text='Both answers' ORDER BY room_id`, [A])).rows)
    .toEqual([{room_id:R1},{room_id:R2}]);
});

it('reuses a mid-turn reply for the whole batch and carries every attachment', async () => {
  const first = await ask(R1,'first batch asker');
  const second = await ask(R1,'second batch asker');
  const posted = await daemon.execute('postCornerMessage', { roomId:R1,cornerId:R1,requestId:first.id,text:'Both answers from the tool.' }, A);
  const file = {url:'https://example.test/batch-proof',name:'batch-proof.txt',mimeType:'text/plain',size:12};
  await db.query('UPDATE agent_commands SET answer_attachments=$2::jsonb WHERE id=$1',[second.id,JSON.stringify([file])]);
  await daemon.execute('postRoomMessage',{roomId:R1,requestId:first.id,queuedRequestIds:[second.id],text:'Closing summary'},A);
  expect(await queue()).toEqual([]);
  expect((await db.query('SELECT attachments FROM messages WHERE id=$1',[posted.id])).rows[0]).toEqual({attachments:[file]});
  expect((await db.query("SELECT count(*)::int n FROM messages WHERE author_id=$1 AND room_id=$2 AND text='Closing summary' AND presentation='message'",[A,R1])).rows[0])
    .toEqual({n:0});
});

it('keeps the whole batch queued if one recorded return address cannot receive its answer', async () => {
  const first = await ask(R1,'answer here atomically');
  const second = (await createAgentCommand(db,{roomId:R1,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',text:'answer in Two atomically',authorId:H,fromRoomId:R2}}))!;
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[R2,H]);
  try {
    await expect(daemon.execute('postRoomMessage',{roomId:R1,requestId:first.id,queuedRequestIds:[second.id],text:'Atomic batch answer'},A))
      .rejects.toThrow('return address');
    expect((await queue()).map(item=>item.id)).toEqual([first.id,second.id]);
    expect((await db.query("SELECT 1 FROM messages WHERE author_id=$1 AND text='Atomic batch answer'",[A])).rows).toEqual([]);
  } finally { await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2',[R2,H]); }
});
