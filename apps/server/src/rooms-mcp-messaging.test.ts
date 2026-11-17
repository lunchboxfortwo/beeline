import { sendMessage } from './agent-messaging.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptMemberDelivery } from '../../body/src/session-join/bridge.js';
import { takeInbox,updateState,type JoinedSession } from '../../body/src/session-join/store.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { AGENT,PRIVATE,PUBLIC_CORNER,ROOM,USER,describe,expect,fixtureScope1,fixtureScope3,it } from './test-support-rooms-mcp.test-support.js';

describe('connected agent message protocol',()=>{
  const scope=fixtureScope1(), tools=fixtureScope3(scope);
  const handle=async(member:string)=>(await scope.db.query<{handle:string}>(
    'SELECT beeline_room_handle($1,$2) handle',[member,ROOM])).rows[0]!.handle;
  const humanTask=async(member:string,text='Inspect the widget')=>{
    const source=await scope.phone.execute('sendRoomMessage',{roomId:ROOM,text:`@${await handle(member)} ${text}`},USER);
    const task=(await scope.db.query<{id:string}>('SELECT id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2',[member,source.messageId])).rows[0]!;
    return {...source,id:task.id};
  };
  it('keeps a tagged image on message reads and the session-helper wake',async()=>{
    const {client,member}=await scope.connected();
    const image={url:'https://files.example.test/browser-screen.jpg',name:'browser-screen.jpg',mimeType:'image/jpeg',size:176684,width:1080,height:2340};
    const source=await scope.phone.execute('sendRoomMessage',{
      roomId:ROOM,text:`@${await handle(member)} keyboard not centered in its button`,attachments:[image],
    },USER);
    const direct=await tools.ok(client,'read',{address:ROOM,facet:'message',messageId:source.messageId});
    const page=await tools.ok(client,'read_messages',{room:ROOM});
    const delivery=await tools.ok(client,'list_mentions',{});
    const command=(await readAgentCommands(scope.db,member)).commands.find(item=>item.sourceMessageId===source.messageId)!;
    expect(direct.attachments).toEqual([image]);
    expect(command.source.attachments).toEqual([image]);
    expect(itemPrompt(command,{names:new Map()})).toContain('📎 browser-screen.jpg (image/jpeg, 173 KB)');
    expect(page.messages.find((item:{id:string})=>item.id===source.messageId)).toMatchObject({attachments:[image]});
    expect(delivery.mentions.find((item:{id:string})=>item.id===source.messageId)).toMatchObject({attachments:[image]});
    expect(delivery.wakes.find((item:{id:string})=>item.id===command.id)).toMatchObject({attachments:[image]});
    const dir=await mkdtemp(join(tmpdir(),'tagged-image-session-'));
    try {
      const joined:JoinedSession={key:'codex:/image-proof',agent:'codex',cwd:'/image-proof',name:'Image proof',server:scope.origin,
        clientId:'fixture',cursor:'0',deliveredWakes:[],joinedAt:''};
      await updateState(dir,state=>state.sessions.push(joined));
      const mention=delivery.mentions.find((item:{id:string})=>item.id===source.messageId);
      await acceptMemberDelivery(dir,joined.key,{node:'/proof/node',bundle:'/proof/beeline.mjs'},
        {v:1,type:'delivery',deliveryId:`mention:${source.messageId}`,mentionCursor:delivery.nextCursor,mentions:[mention],wakes:[]});
      const inbox=takeInbox(dir,joined.key);
      expect(inbox).toContain(image.name);expect(inbox).toContain(image.url);expect(inbox).toContain(image.mimeType);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it('the SDK sends privately to one tuple and receives a reply at its sending place',async()=>{
    const {client,member}=await scope.connected();
    const sent=await tools.ok(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Check the widget'});
    expect(sent.id).toMatch(/^[0-9a-f]{64}$/);
    expect((await scope.db.query('SELECT agent_id,room_id,message FROM agent_commands WHERE id=$1',[sent.id])).rows)
      .toMatchObject([{agent_id:AGENT,room_id:ROOM,message:{route:{from:{agent:member,place:ROOM},to:{agent:AGENT,place:ROOM}},body:'Check the widget'}}]);
    await scope.daemon.execute('reply',{id:sent.id,text:'Checked'},AGENT);
    const page=await tools.ok(client,'list_mentions',{});
    expect(page.wakes).toEqual([expect.objectContaining({address:ROOM,from:{agent:AGENT,place:ROOM},text:'Checked'})]);
    // The session helper rejects a wake frame without a string reason.
    expect(typeof page.wakes[0]!.reason).toBe('string');
    expect(page.wakes[0].next).toContain('reply(');
  });
  it('replies to a received public message id under its own byline without a tag or a card',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    const saved=await tools.ok(client,'reply',{id:task.messageId,text:'The widget works'});
    expect((await scope.db.query('SELECT author_id,room_id,text,card FROM messages WHERE id=$1',[saved.id])).rows)
      .toMatchObject([{author_id:member,room_id:ROOM,text:'The widget works',card:{route:{from:{agent:member,place:ROOM},to:{agent:USER,place:ROOM}}}}]);
    expect((await tools.ok(client,'list_mentions',{})).mentions).toEqual([]);
    expect((await scope.db.query('SELECT 1 FROM work_questions WHERE message_id=$1',[saved.id])).rowCount).toBe(0);
  });
  it('resolves the thread implementer after a later person tag of another agent',async()=>{
    const {client,member}=await scope.connected();
    await scope.db.query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1',[PUBLIC_CORNER,AGENT]);
    await scope.phone.execute('sendRoomMessage',{roomId:PUBLIC_CORNER,text:`@${await handle(member)} Conversation only`},USER);
    const sent=await tools.ok(client,'message',{address:ROOM,to:{agent:'implementer',place:PUBLIC_CORNER},text:'Inspect this thread'});
    expect((await scope.db.query('SELECT agent_id,room_id FROM agent_commands WHERE id=$1',[sent.id])).rows)
      .toEqual([{agent_id:AGENT,room_id:PUBLIC_CORNER}]);
  });
  it('exposes only the thread parameter and header names at the connector boundary',async()=>{
    const {client}=await scope.connected();
    const list=await tools.ok(client,'list_threads',{room:ROOM});
    expect(list.threads).toContainEqual(expect.objectContaining({thread:expect.objectContaining({id:PUBLIC_CORNER})}));
    expect(list).not.toHaveProperty('corners');
    expect(await tools.ok(client,'thread_status',{thread:PUBLIC_CORNER})).toHaveProperty('thread');
    expect((await tools.call(client,'thread_status',{corner:PUBLIC_CORNER})).error).toBe(true);
    for(const name of ['send_message','order','report','ask_owner','merge_thread','record_merge_yes','react_to_message','notify_feedback_fixed'])
      expect((await tools.call(client,name,{})).error).toBe(true);
  });
  it('requires membership at both a new message call site and its destination',async()=>{
    const {client}=await scope.connected();
    for(const [address,place] of [[PRIVATE,ROOM],[ROOM,PRIVATE]])
      expect((await tools.call(client,'message',{address,to:{agent:USER,place},text:'Forbidden'})).error).toBe(true);
  });
  it('keeps two asks independent and records the recommended option',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    const ask={question:'Which proof?',options:['Server','Body'],recommended:'Server'};
    const first=await tools.ok(client,'reply',{id:task.id,text:'Choose a proof',ask});
    const second=await tools.ok(client,'reply',{id:task.id,text:'Choose another proof',ask});
    expect(first.id).not.toBe(second.id);
    expect((await scope.db.query('SELECT message_id,recommended_option_id FROM work_questions WHERE message_id=ANY($1::text[])',[ [first.id,second.id] ])).rows)
      .toEqual(expect.arrayContaining([{message_id:first.id,recommended_option_id:expect.any(String)},{message_id:second.id,recommended_option_id:expect.any(String)}]));
  });
  it('never selects another message when the supplied reply id is unavailable',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    expect((await tools.call(client,'reply',{id:'0'.repeat(64),text:'Missing'})).error).toBe(true);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'pending'}]);
    const other=await sendMessage(scope.db,{route:{from:{agent:USER,place:ROOM},to:{agent:AGENT,place:ROOM}},text:'For another member'});
    expect((await tools.call(client,'reply',{id:other.id,text:'Not mine'})).error).toBe(true);
  });
  it('answers explicitly selected messages in any order without spending another item',async()=>{
    const {client,member}=await scope.connected();
    const first=await humanTask(member,'First task'),second=await humanTask(member,'Second task');
    await tools.ok(client,'reply',{id:second.id,text:'Second complete'});
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[first.id])).rows).toEqual([{state:'pending'}]);
    await tools.ok(client,'reply',{id:first.id,text:'First complete'});
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=ANY($1::text[])',[[first.id,second.id]])).rows)
      .toEqual([{state:'complete'},{state:'complete'}]);
  });
  it('relays a worker outcome to the original human task id rather than tagging a reviewer in chat',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    await scope.db.query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1',[PUBLIC_CORNER,AGENT]);
    const work=await tools.ok(client,'message',{address:ROOM,to:{agent:'implementer',place:PUBLIC_CORNER},text:'Check the widget'});
    await scope.daemon.execute('reply',{id:work.id,text:'Checked'},AGENT);
    const wake=(await tools.ok(client,'list_mentions',{})).wakes.find((item:{text:string})=>item.text==='Checked');
    expect(wake).toMatchObject({address:ROOM,from:{agent:AGENT,place:PUBLIC_CORNER}});
    const final=await tools.ok(client,'reply',{id:task.id,text:'The widget is checked'});
    expect((await scope.db.query('SELECT room_id,card FROM messages WHERE id=$1',[final.id])).rows)
      .toMatchObject([{room_id:ROOM,card:{route:{to:{agent:USER,place:ROOM}}}}]);
    expect((await scope.db.query("SELECT state FROM agent_commands WHERE id=$1",[work.id])).rows).toEqual([{state:'complete'}]);
    expect((await scope.db.query("SELECT 1 FROM agent_commands WHERE parent_command_id=$1 AND agent_id=$2 AND state='pending'",[task.id,AGENT])).rowCount).toBe(0);
  });
  it('rolls a failed queue append back, then accepts an explicit fresh call',async()=>{
    const {client,member}=await scope.connected();
    await scope.db.query(`CREATE FUNCTION reject_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append failed'; END $$;
      CREATE TRIGGER reject_message BEFORE INSERT ON agent_commands FOR EACH ROW EXECUTE FUNCTION reject_message()`);
    try {
      expect((await tools.call(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Atomic request'})).error).toBe(true);
    } finally {await scope.db.query('DROP TRIGGER reject_message ON agent_commands; DROP FUNCTION reject_message()');}
    expect((await scope.db.query("SELECT 1 FROM agent_commands WHERE private_payload->'route'->'from'->>'agent'=$1",[member])).rowCount).toBe(0);
    const sent=await tools.ok(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Atomic request'});
    expect((await scope.db.query('SELECT 1 FROM agent_commands WHERE id=$1',[sent.id])).rowCount).toBe(1);
  });
});
