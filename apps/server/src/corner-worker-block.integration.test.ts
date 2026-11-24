import { needsYouMarksSchema } from './needs-you-marks.js';
import { closeAgentAsk } from './agent-open-asks.js';
import { blockReminder } from './implementer-blocks.js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate, type SqlDatabase } from './database.js';
import { PgliteDatabase, insertCornerFacts } from './test-support.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { refreshCornerAttention, runCornerAttention } from './corner-attention.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { cornerIdleSql } from './corner-idle.js';
import { loadCornerWaiting } from './corner-waiting.js';
import { modelText } from './message-origin.js';

const WS = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HUMAN = 'a'.repeat(64), COMMANDER = 'b'.repeat(64), WORKER = 'c'.repeat(64), REVIEWER = 'd'.repeat(64);
let db: SqlDatabase, pg: PgliteDatabase, daemon: HelperDaemonService, phone: PhoneService;
beforeAll(async () => {
  pg = new PgliteDatabase(); db = pg; await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Reviewer','reviewer')`, [HUMAN, COMMANDER, WORKER, REVIEWER]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)', [COMMANDER, WORKER, REVIEWER, HUMAN]);
  daemon = new HelperDaemonService(db, new LiveHub()); phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => pg.close());
beforeEach(async () => {
  await db.query('DELETE FROM workspaces'); await db.query('DELETE FROM agent_connections');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Worker blocks')", [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by,reviewer_agent_id)
    VALUES($1,$2,'Room',$3,$4)`, [ROOM, WS, HUMAN, REVIEWER]);
  for (const member of [HUMAN, COMMANDER, WORKER, REVIEWER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, member, ROOM]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Corner',$4)`, [C, WS, ROOM, COMMANDER]);
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: WORKER, commissionedBy: HUMAN });
  // Like the incident, the worker is the creator; the opening route still names the commander.
  await db.query("UPDATE rooms SET created_by=$2,created_at=now()-interval '1 day' WHERE id=$1", [C, WORKER]);
});
const state = async () => { await refreshCornerAttention(db, C); return (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state; };
async function input(agent = WORKER) {
  const command = (await createAgentCommand(db, { id: randomUUID(), roomId: C, agentId: agent,
    sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: agent === WORKER ? COMMANDER : HUMAN,
      fromRoomId: ROOM, text: modelText('Continue.') } }))!;
  await startQueuedCommand(daemon, { roomId: C, commandId: command.id }, agent);
  return { roomId: C, requestId: command.turn_request_id };
}
const idleReports = async () => (await db.query(`SELECT id FROM agent_commands WHERE COALESCE(private_payload->>'originCornerId',private_payload->>'fromRoomId')=$1::text AND private_payload->>'automatic'='true'
  AND private_payload->>'authorId'=$2 AND private_payload->>'text' ~ '^blocked: (Thread|Corner) .* is idle\.'`, [C, SYSTEM_IDENTITY_ID])).rows;
async function reactions(count = 8) {
  for (let i = 0; i < count; i++) {
    await refreshCornerAttention(db, C);
    const report = (await readAgentCommands(db, COMMANDER, ROOM)).commands.find(c => c.source.authorId === SYSTEM_IDENTITY_ID && c.source.body.includes(' is idle.'));
    if (!report) break;
    await startQueuedCommand(daemon, { roomId:report.roomId,commandId:report.id }, COMMANDER);
    await daemon.execute('postRoomMessage', { roomId:report.roomId,requestId:report.turnRequestId, text: 'Still waiting on secrets.' }, COMMANDER);
  }
}
it('IDLE-BUDGET: commander reactions produce exactly one notice until a person event', async () => {
  await reactions(); await runCornerAttention(db);
  expect(await idleReports()).toHaveLength(1);
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
    SELECT $1,'legacy-reaction-'||n,$2,'complete' FROM generate_series(1,728) n`, [C, COMMANDER]);
  await runCornerAttention(db);
  expect(await idleReports()).toHaveLength(1);
  await daemon.execute('postRoomMessage', { ...await input(), text: 'Worker finished more work.' }, WORKER);
  await reactions();
  expect(await idleReports()).toHaveLength(1); // Worker output is not a budget reset.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('person-input',$1,$2,'Use option one.','message')`, [C, HUMAN]);
  await reactions();
  expect(await idleReports()).toHaveLength(2);
});
it.each(['blocked', 'needs_decision'] as const)('WORKER-BLOCK: real %s report stays open through orders, turns and prose until worker outcome, yielding the state to work', async status => {
  const turn = await input();
  const report = await daemon.execute('report', { ...turn, status, text: 'The router-login secrets are missing.' }, WORKER);
  expect(await blockReminder(db,WORKER,C)).toContain(report.id);
  expect((await readAgentCommands(db,COMMANDER,ROOM)).commands.some(c=>c.id===report.id)).toBe(true);
  expect(await state()).toBe('waiting'); // The report ended its turn; the block is all that remains.
  expect((await db.query("SELECT id FROM messages WHERE card_type='agent-command'")).rows).toEqual([]);
  const next = await input(); // New work keeps the block open and shows Working.
  expect(await state()).toBe('working');
  expect(await loadCornerWaiting(db, C)).toBeDefined();
  await daemon.execute('postRoomMessage', { ...next, text: 'I confirmed the decision. Still waiting on secrets.' }, WORKER);
  await reactions();
  expect(await state()).toBe('waiting');
  expect(await idleReports()).toHaveLength(0);
  const finished = await input();
  await expect(daemon.execute('report',{...finished,status:'done',text:'Complete.'},WORKER)).rejects.toThrow(report.id);
  await closeAgentAsk(db,WORKER,{messageId:report.id,reason:'answered'});
  await daemon.execute('report', { ...finished, status: status === 'blocked' ? 'done' : 'failed', text: 'The task is complete.' }, WORKER);
  expect(await state()).toBe('idle');
});
it('WORKER-ROLE: a worker-created corner displays worker activity and a commander turn there as working', async () => {
  const commander = await input(COMMANDER);
  expect(await state()).toBe('working');
  await daemon.execute('postRoomMessage', { ...commander, text: 'Acknowledged.' }, COMMANDER);
  expect(await state()).toBe('idle');
  const worker = await input();
  expect(await state()).toBe('working');
  await daemon.execute('postRoomMessage', { ...worker, text: 'Finished.' }, WORKER);
  expect(await state()).toBe('idle');
});
it('WORKER-BLOCK: native ask cards keep the block open through commander chatter while work shows Working', async () => {
  await daemon.execute('report', { ...await input(), status: 'blocked', text: 'Need a decision.' }, WORKER);
  const ask = await input();
  const choice = await daemon.execute('askRoomChoice', { ...ask, prompt: 'Which scope?',
    options: [{ label: 'One' }, { label: 'Two' }] }, WORKER);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('commander-chatter',$1,$2,'Use option one.','message'),('person-chatter',$1,$3,'Looking.','message')`, [C, COMMANDER, HUMAN]);
  expect(await state()).toBe('working'); // The asking turn still runs.
  expect(await loadCornerWaiting(db, C)).toBeDefined();
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'working', workingAgentName: expect.any(String) });
  await phone.execute('answerChoice', { choiceId: choice.choiceId, optionId: 'A' }, HUMAN);
  await daemon.execute('postRoomMessage', { ...ask, text: 'Continuing with that choice.' }, WORKER);
  expect(await state()).toBe('working'); // The native decision queued its own continuation.
});

it('counts a notice sent before the thread wording change against the same idle budget', async () => {
  await reactions();
  const [notice] = await idleReports();
  expect(notice).toBeDefined();
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{text}',
    to_jsonb(replace(private_payload->>'text','blocked: Thread ','blocked: Corner '))) WHERE id=$1`, [notice!.id]);
  expect((await db.query(cornerIdleSql('$1'), [C])).rows[0]).toMatchObject({ idle_report_count: 1 });
  await runCornerAttention(db); await refreshCornerAttention(db, C);
  expect(await idleReports()).toHaveLength(1);
});

it('IDLE-BUDGET: only human grant decisions and human hold releases replenish notices', async () => {
  await reactions(); expect(await idleReports()).toHaveLength(1);
  const grant = randomUUID();
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,decided_by,decided_at)
    VALUES($1,$2,$3,$4,'command','true','Proof',$5,'approved',$6,clock_timestamp())`, [grant, WORKER, WS, C, HUMAN, COMMANDER]);
  await reactions(); expect(await idleReports()).toHaveLength(1);
  await db.query('UPDATE agent_grants SET decided_by=$2,decided_at=clock_timestamp() WHERE id=$1', [grant, HUMAN]);
  await reactions(); expect(await idleReports()).toHaveLength(2);
  const hold = await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(2);
  await phone.execute('setCornerHold', { cornerId: C, releaseHoldId: hold.holdId }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(3);
});

it('WORKER-BLOCK: granted-run and read activity keep the block open and show Working', async () => {
  await daemon.execute('report', { ...await input(), status: 'blocked', text: 'Waiting for execution.' }, WORKER);
  const next = await input();
  await daemon.execute('postAgentActivity', { ...next, activity: [{ kind: 'tool', title: 'read status', operation: 'read' }] }, WORKER);
  expect(await state()).toBe('working');
  expect(await loadCornerWaiting(db, C)).toBeDefined();
  const grant = randomUUID();
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status)
    VALUES($1,$2,$3,$4,'command','true','Proof',$5,'approved')`, [grant, WORKER, WS, ROOM, HUMAN]);
  await daemon.execute('postAgentActivity', { ...next, activity: [{ kind: 'tool',
    title: `ran true under grant ${grant} · asked by Owner`, operation: 'execute', status: 'exit 0' }] }, WORKER);
  expect(await state()).toBe('working');
  expect(await loadCornerWaiting(db, C)).toBeDefined();
});

it('IDLE-BUDGET: moving a PR head cannot rearm receipts after completed notices are retired', async () => {
  await reactions();
  const reports = await idleReports(); expect(reports).toHaveLength(1);
  await db.query('DELETE FROM agent_commands WHERE id=ANY($1::text[])', [reports.map(row => row.id)]);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, JSON.stringify({
    checks: 'unknown', pr: { number: 1, headSha: 'new-head' },
    checksSummary: { status: 'unknown', total: 0, checks: [], failing: [], fetchStartedAt: 0, updatedAt: 0 },
  })]);
  await reactions();
  expect(await idleReports()).toHaveLength(0);
});

it('IDLE-BUDGET: a native human permission decision restores one notice', async () => {
  await reactions(); expect(await idleReports()).toHaveLength(1);
  await db.query(`INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
    VALUES('permission-proof',$1,$2,'permission-request','{}'::jsonb,'pending')`, [C, HUMAN]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES('permission-ask',$1,$2,'Allow edits','card','permission',$3::jsonb)`, [C, WORKER, JSON.stringify({
      permissionId: 'permission-proof', requestId: 'permission-request', agent: { pubkey: WORKER }, repository: 'owner/widgets',
    })]);
  await phone.execute('decideWritePermission', { permissionId: 'permission-proof', roomId: C, agentId: WORKER,
    requestId: 'permission-request', repository: 'owner/widgets', decision: 'allow' }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(2);
});

it.each([false, true])('Reproduction 22 Nov schedule-target-place: reply clears Tasks only (threaded=%s)', async threaded => {
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES('ruby-decision',$1,$2,'needs-decision: Use this approach?',
      jsonb_build_object('reportToId',$3::text,'reportStatus','needs-decision'),now()-interval '1 minute')`, [C, WORKER, HUMAN]);
  expect(await state()).toBe('waiting');
  const tasks=async()=> (await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items.map(item=>item.messageId);
  expect(await tasks()).toContain('ruby-decision');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id)
    VALUES('owner-yes',$1,$2,'yes',$3)`, [C, HUMAN, threaded ? 'ruby-decision' : null]);
  expect(await tasks()).toEqual(threaded ? [] : ['ruby-decision']);
  expect(await state()).toBe('waiting');
  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]).toMatchObject({state:'waiting'});
  expect(await blockReminder(db,WORKER,C)).toContain(threaded?'answered':'unanswered');
  await closeAgentAsk(db,WORKER,{messageId:'ruby-decision',reason:'answered'});
  expect(await loadCornerWaiting(db,C)).toBeUndefined();
  expect((await phone.readCorners(ROOM,HUMAN))!.corners[0]).toMatchObject({state:'idle'});
  expect(await tasks()).toEqual([]);
});

it.each([false,true])('BLOCK-CHAIN: re-ask reopens one Tasks row and takeover owns closure (choice=%s)', async(choice)=>{
  if(choice) await db.query('DELETE FROM agent_commands WHERE room_id=$1',[C]);
  await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason:'corner_objective',privatePayload:{kind:'order',authorId:choice?HUMAN:COMMANDER,fromRoomId:ROOM,...(choice?{route:{from:{agent:HUMAN,place:ROOM},to:{agent:WORKER,place:C}}}:{}),text:modelText('Build')}});
  if(choice) {
    const {sendMessage}=await import('./agent-messaging.js');
    await sendMessage(db,{id:'block',route:{from:{agent:WORKER,place:C},to:{agent:HUMAN,place:ROOM}},
      text:'blocked: Need access',ask:{question:'Which access?',options:['One','Two']}});
    const card=(await db.query<{id:string}>('SELECT id FROM room_choices WHERE message_id=$1',['block'])).rows[0]!;
    await phone.execute('answerChoice',{choiceId:card.id,optionId:'A'},HUMAN);
  } else {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) VALUES('block',$1,$2,'blocked: Need access',
      jsonb_build_object('reportToId',$3::text,'reportStatus','blocked'))`,[C,WORKER,HUMAN]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id) VALUES('answer',$1,$2,'Ready','block')`,[C,HUMAN]);
  }
  expect((await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items).toHaveLength(0);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id) VALUES('reask',$1,$2,'Still need access',$3)`,[C,WORKER,choice?'block':'answer']);
  expect((await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items.map(i=>i.messageId)).toEqual(['block']);
  await db.query(`UPDATE messages SET text='Still need access, please' WHERE id='reask'`);
  expect((await db.query("SELECT * FROM needs_you_marks WHERE message_id='block'")).rows).toHaveLength(1);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id) VALUES('second-answer',$1,$2,'Answered again','reask')`,[C,HUMAN]);
  await db.query(`UPDATE messages SET text='Edited re-ask' WHERE id='reask'`);
  expect((await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items).toHaveLength(0);
  await db.query('UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1',[ROOM]);
  await daemon.execute('becomeImplementer',await input(REVIEWER),REVIEWER);
  await expect(closeAgentAsk(db,WORKER,{messageId:'block',reason:'withdrawn'})).rejects.toThrow('current implementer');
  expect(await blockReminder(db,REVIEWER,C)).toContain('block');
  await closeAgentAsk(db,REVIEWER,{messageId:'block',reason:'answered'});
  expect((await db.query("SELECT ask_closed_by FROM messages WHERE id='block'")).rows[0]).toEqual({ask_closed_by:REVIEWER});
});

it.each([COMMANDER,HUMAN])('BLOCK-OVERRIDE: commander or higher person clears and records actor %s',async actor=>{
  await input(); // Establish the opening commander.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) VALUES('override',$1,$2,'blocked: Offline',
    jsonb_build_object('reportToId',$3::text,'reportStatus','blocked'))`,[C,WORKER,HUMAN]);
  if(actor===HUMAN) await phone.execute('closeAgentAsk',{messageId:'override',reason:'withdrawn'},actor);
  else await closeAgentAsk(db,actor,{messageId:'override',reason:'withdrawn'});
  expect((await db.query("SELECT ask_closed_by FROM messages WHERE id='override'")).rows[0]).toEqual({ask_closed_by:actor});
});

it('BLOCK-PROMPT: every queued implementer turn includes unchanged open blocks',async()=>{
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) VALUES('prompt-block',$1,$2,'blocked: Offline',
    jsonb_build_object('reportToId',$3::text,'reportStatus','blocked'))`,[C,WORKER,HUMAN]);
  for(let n=0;n<6;n++) await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) SELECT $1,room_id,author_id,text,card FROM messages WHERE id='prompt-block'`,['prompt-extra-'+n]);
  for(let n=0;n<2;n++) {
    await input();
    const command=(await db.query<{message:{openAsksChanged:string}}>(`SELECT message FROM agent_commands WHERE agent_id=$1 AND room_id=$2 ORDER BY inbox_sequence DESC LIMIT 1`,[WORKER,C])).rows[0]!;
    expect(command.message.openAsksChanged).toContain('prompt-block');
    expect(command.message.openAsksChanged).toContain('clear those that no longer hold');
    expect(command.message.openAsksChanged.split('\n').filter(line=>line.startsWith('- '))).toHaveLength(5);
    expect(command.message.openAsksChanged).toContain('2 more');
  }
});

it('BLOCK-LINK: commander passes a block to a person without looping back to its source',async()=>{
  await input();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card) VALUES('source',$1,$2,'blocked: Need input',
    jsonb_build_object('reportToId',$3::text,'reportStatus','blocked','sourceRoomId',$4::text))`,[ROOM,WORKER,COMMANDER,C]);
  await expect(db.query(`INSERT INTO messages(id,room_id,author_id,text,card,reply_to_message_id)
    VALUES('loop',$1,$2,'blocked: Answer me',jsonb_build_object('reportToId',$3::text,'reportStatus','blocked'),'source')`,[ROOM,COMMANDER,WORKER])).rejects.toThrow('cannot target');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,reply_to_message_id)
    VALUES('passed-up',$1,$2,'blocked: Need your input',jsonb_build_object('reportToId',$3::text,'reportStatus','blocked','sourceRoomId',$4::text),'source')`,[ROOM,COMMANDER,HUMAN,ROOM]);
  expect((await db.query("SELECT block_parent_id FROM messages WHERE id='passed-up'")).rows[0]).toEqual({block_parent_id:'source'});
  expect(await blockReminder(db,COMMANDER,ROOM)).toContain('passed-up');
  await closeAgentAsk(db,COMMANDER,{messageId:'passed-up',reason:'answered'});
  expect(await blockReminder(db,WORKER,C)).toContain('source');
});

it('BLOCK-MIGRATION: legacy private report becomes a closeable block once',async()=>{
  const report=await daemon.execute('report',{...await input(),status:'blocked',text:'Legacy access needed'},WORKER);
  await db.query('DELETE FROM messages WHERE id=$1',[report.id]);
  await db.query("DELETE FROM workflow_backfills WHERE name='implementer-blocks-v1'");
  await db.query(needsYouMarksSchema());
  expect(await blockReminder(db,WORKER,C)).toContain(report.id);
  await closeAgentAsk(db,WORKER,{messageId:report.id,reason:'withdrawn'});
  await db.query(needsYouMarksSchema());
  expect(await blockReminder(db,WORKER,C)).toBe('');
});

it('BLOCK-MESSAGE: plain blocks route to commander, who can pass a linked question to a person',async()=>{
  const { sendMessage }=await import('./agent-messaging.js');
  const opening=(await createAgentCommand(db,{roomId:C,agentId:WORKER,sourceMessageId:null,reason:'corner_objective',
    privatePayload:{kind:'order',authorId:COMMANDER,fromRoomId:ROOM,text:modelText('Build')}}))!;
  const block=await sendMessage(db,{route:{from:{agent:WORKER,place:C},to:{agent:HUMAN,place:ROOM}},text:'blocked: Need the access code',parent:opening});
  const row=(await db.query(`SELECT presentation,card_type,block_corner_id,card->>'reportToId' recipient FROM messages WHERE id=$1`,[block.id])).rows[0];
  expect(row).toEqual({presentation:'message',card_type:null,block_corner_id:C,recipient:COMMANDER});
  const parent=(await db.query<import('./agent-command.js').CommandRow>('SELECT * FROM agent_commands WHERE id=$1',[block.id])).rows[0]!;
  expect(parent).toMatchObject({agent_id:COMMANDER,room_id:ROOM,reason:'message',state:'pending'});
  const response=await sendMessage(db,{route:{from:{agent:COMMANDER,place:ROOM},to:{agent:WORKER,place:C}},text:'I am checking access',replyTo:block.id,parent});
  expect(await blockReminder(db,WORKER,C)).toContain('; answered');
  await sendMessage(db,{route:{from:{agent:WORKER,place:C},to:{agent:COMMANDER,place:ROOM}},text:'Still need access',replyTo:response.id});
  expect(await blockReminder(db,WORKER,C)).toContain('; unanswered');
  const passed=await sendMessage(db,{route:{from:{agent:COMMANDER,place:ROOM},to:{agent:HUMAN,place:ROOM}},text:'blocked: Please provide access',parent});
  expect((await db.query('SELECT block_parent_id FROM messages WHERE id=$1',[passed.id])).rows[0]).toEqual({block_parent_id:block.id});
  expect((await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items.map(i=>i.messageId)).toEqual([passed.id]);
  await phone.execute('sendRoomReply',{roomId:ROOM,parentMessageId:passed.id,text:'Access is restored'},HUMAN);
  expect((await phone.execute('readNeedsYou',{workspaceId:WS},HUMAN)).items).toHaveLength(0);
  expect((await readAgentCommands(db,COMMANDER,ROOM)).commands.some(c=>c.source.body==='Access is restored')).toBe(true);
  await closeAgentAsk(db,COMMANDER,{messageId:passed.id,reason:'answered'});
  expect(await blockReminder(db,WORKER,C)).toContain(block.id);
});
