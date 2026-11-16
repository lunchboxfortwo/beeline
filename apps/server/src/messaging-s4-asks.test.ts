import { it,expect } from 'vitest';
import { readWorkBoard } from './work-board.js';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerRoomChoice } from './room-choice.js';
import { needsYouItems } from './needs-you.js';
import { phoneIdentity } from './phone-identity.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';
import { H,A,B,W,CHAT,THREAD,db,queued } from './messaging.test-support.js';
const ask={question:'Which output?',options:['Web','Phone'],recommended:'Web'};
const tray=async()=>(await needsYouItems(db,W,H,row=>phoneIdentity(row,''))).items;
it('S4: asks to a person create independent cards; answering clears that card alone, and plain replies create none',async()=>{
  const first=await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:H,place:CHAT}},text:'Choose output',ask});
  const second=await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:H,place:CHAT}},text:'Choose next output',ask});
  await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:H,place:CHAT}},text:'blocked: plain progress without an ask'});
  expect((await tray()).map(item=>item.messageId)).toEqual([first.id,second.id]);
  const cards=(await readWorkBoard(db,W,H)).items.filter(item=>item.ask);
  expect(cards.map(item=>item.askIds)).toEqual([[first.id],[second.id]]);
  expect(cards[0]!.source).toEqual({roomId:THREAD,label:'#Milo ↳ Widget'});
  expect(await queued()).toEqual([]);
  const choice=(await db.query<{id:string;options:{optionId:string}[]}>(
    'SELECT id,options FROM room_choices WHERE message_id=$1',[first.id])).rows[0]!;
  await answerRoomChoice(db,{choiceId:choice.id,optionId:choice.options[0]!.optionId,viewerId:H});
  expect((await tray()).map(item=>item.messageId)).toEqual([second.id]);
  expect(await queued()).toEqual([[B,THREAD]]);
});
it('S4: an ask to an agent commander keeps the thread waiting until that recipient replies',async()=>{
  const question=await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:A,place:CHAT}},text:'Need a choice',ask});
  const waiting=async()=>(await db.query(`SELECT waiting.person_id FROM rooms thread
    CROSS JOIN LATERAL (${cornerWaitingReportSql('thread')}) waiting WHERE thread.id=$1`,[THREAD])).rows;
  expect(await waiting()).toEqual([{person_id:A}]);
  expect(await tray()).toEqual([]);
  await replyToMessage(db,A,{id:question.id,text:'Web'});
  expect(await waiting()).toEqual([]);
  expect(await queued()).toEqual([[B,THREAD]]);
});

it('S4: a transport duplicate creates one card and separate replies can ask independent questions',async()=>{
  const task=await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:THREAD}},text:'Build widget'});
  const first=await replyToMessage(db,B,{id:task.id,text:'Choose output',ask,messageId:'e'.repeat(64)});
  await replyToMessage(db,B,{id:task.id,text:'Choose output',ask,messageId:'e'.repeat(64)});
  const second=await replyToMessage(db,B,{id:task.id,text:'Choose another output',ask});
  expect(second.id).not.toBe(first.id);
  expect((await tray()).map(item=>item.messageId)).toEqual([first.id,second.id]);
  expect((await db.query('SELECT 1 FROM room_choices')).rowCount).toBe(2);
  expect(await queued()).toEqual([]);
});
it('S4: answering an ask from a closed origin clears only that card without rerouting',async()=>{
  const sent=await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:H,place:CHAT}},text:'Choose output',ask});
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[THREAD]);
  const choice=(await db.query<{id:string;options:{optionId:string}[]}>('SELECT id,options FROM room_choices WHERE message_id=$1',[sent.id])).rows[0]!;
  await answerRoomChoice(db,{choiceId:choice.id,optionId:choice.options[0]!.optionId,viewerId:H});
  expect(await tray()).toEqual([]);
  expect(await queued()).toEqual([]);
});
