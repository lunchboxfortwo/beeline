// Isolated built-service proof; no production credentials, daemon or Room writes.
// Run after the server build: node --import tsx packages/scripts/prove-implementer-blocks.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase, insertCornerFacts } from '../../apps/server/src/test-support.ts';
const base = pathToFileURL(resolve(process.env.BEELINE_BLOCK_PROOF_SERVER ?? 'apps/server/dist') + '/');
const load = name => import(new URL(name + '.js', base));
const [{ migrate }, { HelperDaemonService }, { PhoneService }, { LiveHub }, { createAgentCommand }, { refreshCornerAttention }, { modelText }] = await Promise.all(
  ['database','test-fixtures/helper-daemon','phone-service','live','agent-command','corner-attention','message-origin'].map(load));
const before = process.argv.includes('--before');
const db = new PgliteDatabase();
const human = 'a'.repeat(64), worker = 'b'.repeat(64);
const workspace = randomUUID(), room = randomUUID(), corner = randomUUID();
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`, [human,worker]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[worker,human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Block proof')",[workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)",[room,workspace,human]);
  for (const person of [human,worker]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[workspace,person,room]);
  await db.query("INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Block',$4)",[corner,workspace,room,worker]);
  await insertCornerFacts(db,{cornerId:corner,ownerAgentId:worker,commissionedBy:human});
  const daemon = new HelperDaemonService(db,new LiveHub()), phone = new PhoneService(db,'http://isolated-proof');
  const command = await createAgentCommand(db,{id:randomUUID(),roomId:corner,agentId:worker,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:human,fromRoomId:room,text:modelText('Build the assigned work.')}});
  await daemon.execute('startAgentTurn',{roomId:corner,requestId:command.turn_request_id},worker);
  const turn={roomId:corner,requestId:command.turn_request_id};
  const report=await daemon.execute('message',{...turn,type:'blocked',text:'Which scope should I build?'},worker);
  await daemon.execute('postRoomMessage',{...turn,text:'',harnessEnded:true},worker);
  const state=async()=>{
    await refreshCornerAttention(db,corner);
    return (await phone.readCorners(room,human)).corners.find(row=>row.corner.id===corner).state;
  };
  const tasks=async()=>(await phone.execute('readNeedsYou',{workspaceId:workspace},human)).items.map(item=>item.messageId);
  assert.equal(await state(),'waiting');
  assert((await tasks()).includes(report.id));
  await phone.execute('sendRoomMessage',{roomId:corner,text:'An unrelated thread message.'},human);
  assert.equal(await state(),before?'idle':'waiting');
  assert((await tasks()).includes(report.id));
  await phone.execute('sendRoomReply',{roomId:room,parentMessageId:report.id,text:'Use the smaller scope.'},human);
  assert(!(await tasks()).includes(report.id));
  assert.equal(await state(),before?'idle':'working');
  assert.equal((await db.query('SELECT ask_closed_reason FROM messages WHERE id=$1',[report.id])).rows[0].ask_closed_reason,null);
  if(!before) {
    await daemon.execute('closeAgentAsk',{...turn,messageId:report.id,reason:'answered'},worker);
    assert.equal(await state(),'working');
    const answer=(await daemon.execute('getAgentCommands',{roomId:corner},worker)).commands[0];
    await daemon.execute('startAgentTurn',{roomId:corner,requestId:answer.turnRequestId},worker);
    await daemon.execute('postRoomMessage',{roomId:corner,requestId:answer.turnRequestId,text:'Continuing with the agreed scope.',harnessEnded:true},worker);
    assert.equal(await state(),'idle');
  }
  if(process.argv.includes('--choice-reask')) {
    const {sendMessage}=await load('agent-messaging');
    const choiceBlock=await sendMessage(db,{type:'blocked',route:{from:{agent:worker,place:corner},to:{agent:human,place:room}},
      text:'blocked: Which access?',ask:{question:'Which access?',options:['One','Two']}});
    const choice=(await db.query('SELECT id FROM room_choices WHERE message_id=$1',[choiceBlock.id])).rows[0];
    await phone.execute('answerChoice',{choiceId:choice.id,optionId:'A'},human);
    assert(!(await tasks()).includes(choiceBlock.id));
    await sendMessage(db,{route:{from:{agent:worker,place:corner},to:{agent:human,place:room}},
      text:'Please answer again',replyTo:choiceBlock.id});
    assert((await tasks()).includes(choiceBlock.id),'Re-asking an answered choice must restore its original Tasks item');
    assert.equal((await db.query('SELECT count(*)::int count FROM needs_you_marks WHERE message_id=$1',[choiceBlock.id])).rows[0].count,1);
    await phone.execute('sendRoomReply',{roomId:room,parentMessageId:choiceBlock.id,text:'Use Two this time'},human);
    assert(!(await tasks()).includes(choiceBlock.id));
    console.log('Choice re-ask: original Tasks item restored once; fresh reply clears it.');
  }
  console.log(JSON.stringify({reproduction:'22 Nov schedule-target-place',mode:before?'reproduced':'demonstrated',
    report:'waiting; Tasks open',unrelatedMessage:before?'WRONG: thread idle; Tasks open':'thread waiting; Tasks open',
    directAnswer:before?'WRONG: thread idle; Tasks cleared':'answer queued; Tasks cleared',
    explicitClosure:before?'not reached':'thread working on answer, then idle; Tasks cleared'}));
} finally { await db.close(); }
