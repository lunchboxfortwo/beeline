import { expect,it } from 'vitest';
import { sendMessage } from './agent-messaging.js';
import { A,B,C,CHAT,THREAD,OTHER,db,daemon } from './messaging.test-support.js';

it.each([CHAT,THREAD])('one combined result in %s publishes one session post and no report',async place=>{
  const requests=[];
  for(let i=0;i<2;i++)requests.push(await sendMessage(db,{
    route:{from:{agent:A,place:CHAT},to:{agent:B,place}},text:'Please run the checks',
  }));
  const file={url:'https://files.test/check-result',name:'checks.txt',mimeType:'text/plain',size:12};
  await db.query('UPDATE agent_commands SET answer_attachments=$2::jsonb WHERE id=$1',
    [requests[1]!.id,JSON.stringify([file])]);
  const input={roomId:place,requestId:requests[0]!.id,queuedRequestIds:[requests[1]!.id],
    text:'Done. The check workflow is open.'};
  const result=await daemon.execute('postRoomMessage',input,B);

  expect((await db.query(`SELECT id,room_id,presentation,card_type,card->>'kind' kind,attachments
    FROM messages WHERE author_id=$1 AND text=$2`,[B,input.text])).rows).toEqual([
    {id:result.id,room_id:place,presentation:'message',card_type:null,kind:null,attachments:[file]},
  ]);
  expect((await db.query(`SELECT id,room_id,agent_id FROM agent_commands
    WHERE agent_id=$1 AND reason='reply'`,[A])).rows).toEqual([]);
  expect((await db.query(`SELECT state,result_message_id,answer_attachments FROM agent_commands
    WHERE id=ANY($1::text[])`,[requests.map(request=>request.id)])).rows).toEqual([
    {state:'complete',result_message_id:result.id,answer_attachments:[]},
    {state:'complete',result_message_id:result.id,answer_attachments:[]},
  ]);

  await daemon.execute('postRoomMessage',input,B);
  expect((await db.query('SELECT 1 FROM messages WHERE author_id=$1 AND text=$2',[B,input.text])).rowCount).toBe(1);
  expect((await db.query("SELECT 1 FROM agent_commands WHERE agent_id=$1 AND reason='reply'",[A])).rowCount).toBe(0);
});

it('a batch from different issuers settles locally',async()=>{
  const destinations=[{agent:A,place:CHAT},{agent:C,place:CHAT},{agent:A,place:OTHER}];
  const requests=[];
  for(const from of destinations)requests.push(await sendMessage(db,{
    route:{from,to:{agent:B,place:THREAD}},text:'Please run the checks',
  }));
  await daemon.execute('postRoomMessage',{roomId:THREAD,requestId:requests[0]!.id,
    queuedRequestIds:requests.slice(1).map(request=>request.id),text:'Checks passed in every place'},B);
  const replies=(await db.query<{room_id:string;agent_id:string}>(`SELECT room_id,agent_id FROM agent_commands
    WHERE reason='reply'`)).rows;
  expect(replies).toEqual([]);
  expect((await db.query("SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state='pending'",[B])).rowCount).toBe(0);
});
