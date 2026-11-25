import { sendMessage } from './agent-messaging.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { applySkillRevision } from './institutional-skills.js';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { callTool as callSessionTool, memberStream } from '../../body/src/session-join/beeline-api.js';
import { acceptMemberDelivery } from '../../body/src/session-join/bridge.js';
import { takeInbox,updateState,type JoinedSession } from '../../body/src/session-join/store.js';
import { memberStreamFrame } from '../../body/src/session-join/stream-frame.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import { AGENT,PRIVATE,PUBLIC_CORNER,ROOM,USER,WORKSPACE,describe,expect,fixtureScope1,fixtureScope3,it } from './test-support-rooms-mcp.test-support.js';

describe('connected agent message protocol',()=>{
  const scope=fixtureScope1(true), tools=fixtureScope3(scope);
  const handle=async(member:string)=>(await scope.db.query<{handle:string}>(
    'SELECT beeline_room_handle($1,$2) handle',[member,ROOM])).rows[0]!.handle;
  const humanTask=async(member:string,text='Inspect the widget')=>{
    const source=await scope.phone.execute('sendRoomMessage',{roomId:ROOM,text:`@${await handle(member)} ${text}`},USER);
    const task=(await scope.db.query<{id:string}>('SELECT id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2',[member,source.messageId])).rows[0]!;
    return {...source,id:task.id};
  };
  it('requires explicit binding to settle a pending request and honors the supplied quote', async () => {
    const { member, token } = await scope.connected();
    const session = { server: scope.origin };
    const args = { address: ROOM, text: '@missing_member Widget inspected.' };
    const standalone = await callSessionTool(session, token, 'post', args);
    const task = await humanTask(member);
    const unbound = await callSessionTool(session, token, 'post', args);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [task.id])).rows).toEqual([{state:'pending'}]);
    expect((await scope.db.query('SELECT reply_to_message_id FROM messages WHERE id=$1', [unbound.messageId])).rows)
      .toEqual([{reply_to_message_id:null}]);
    const answered = await callSessionTool(session, token, 'post', {...args, commandId:task.id, replyTo:standalone.messageId});
    expect(answered).toEqual({ ...standalone, id: expect.any(String), messageId:expect.any(String), createdAt: expect.any(Number) });
    expect((await scope.db.query('SELECT reply_to_message_id FROM messages WHERE id=$1', [answered.messageId])).rows)
      .toEqual([{reply_to_message_id:standalone.messageId}]);
    expect(answered.id).not.toBe(standalone.id);
    for (const post of [standalone, answered]) {
      expect(post).toMatchObject({ address: ROOM, stored: true, visible: true });
      expect((await scope.db.query('SELECT room_id, text FROM messages WHERE id=$1', [post.id])).rows)
        .toEqual([{ room_id: post.address, text: args.text }]);
    }
    expect((await scope.db.query('SELECT state, result_message_id FROM agent_commands WHERE id=$1', [task.id])).rows)
      .toEqual([{ state: 'complete', result_message_id: answered.id }]);
  });
  it('returns no message id when a connected post has no public text to store', async () => {
    const { client, member } = await scope.connected();
    const args = { address: ROOM, text: '<think>private reasoning</think>' };
    const standalone = await tools.ok(client, 'post', args);
    const task = await humanTask(member);
    const answered = await tools.ok(client, 'post', {...args, commandId:task.id});
    for (const post of [standalone, answered]) {
      expect(post).toMatchObject({ id: null, createdAt: null, address: ROOM, stored: false, visible: false });
      expect(Object.keys(post).sort()).toEqual(Object.keys(standalone).sort());
    }
    expect((await scope.db.query('SELECT state, result_message_id FROM agent_commands WHERE id=$1', [task.id])).rows)
      .toEqual([{ state: 'pending', result_message_id: null }]);
  });

  it('opens a listed message by ID and checks the human audience for a cross-chat lookup', async () => {
    const { client, member } = await scope.connected();
    const messageId = 'd'.repeat(64);
    const read = (id: string, address = ROOM) => ({ address, facet: 'message', messageId: id });
    expect((await tools.call(client, 'read', read(messageId))).error).toBe(true);
    await scope.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [WORKSPACE, PRIVATE, member]);
    const listed = await tools.ok(client, 'read', { address: PRIVATE, facet: 'messages' });
    expect(listed.items).toContainEqual(expect.objectContaining({ id: messageId, body: 'private nebula' }));
    expect(await tools.ok(client, 'read', read(messageId, PRIVATE)))
      .toMatchObject({ messageId, body: 'private nebula' });
    expect((await tools.call(client, 'read', read(messageId))).error).toBe(true);
    expect((await tools.call(client, 'read', read(messageId.slice(0, 25)))).error).toBe(true);

    await scope.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [WORKSPACE, PRIVATE, USER]);
    for (const id of [messageId, messageId.slice(0, 25)]) {
      expect(await tools.ok(client, 'read', read(id))).toMatchObject({ messageId, body: 'private nebula' });
    }
    await scope.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [PRIVATE, member]);
    expect((await tools.call(client, 'read', read(messageId))).error).toBe(true);
    expect((await tools.call(client, 'read', read(messageId, PRIVATE))).error).toBe(true);
    await scope.db.query(`DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2`, [PRIVATE, USER]);
  });

  it('opens the same cards that the daemon transcript lists', async () => {
    const { client } = await scope.connected();
    const visibleId = '1'.repeat(64);
    const hiddenId = '2'.repeat(64);
    const deletedId = '3'.repeat(64);
    await scope.db.query(`INSERT INTO messages(id,room_id,author_id,presentation,card_type,text,system_transcript,deleted_at)
      VALUES ($1,$4,$5,'card','choice','Visible card',NULL,NULL),
             ($2,$4,$5,'card','choice','Card hidden from the phone','{"origin":"system","visibility":"hidden"}',NULL),
             ($3,$4,$5,'card','choice','Deleted card',NULL,now())`, [visibleId, hiddenId, deletedId, ROOM, USER]);

    const listed = await tools.ok(client, 'read', { address: ROOM, facet: 'messages', from: 'newest' });
    const cards = listed.items.filter((item: { type: string }) => item.type === 'card');
    for (const [id, body] of [[visibleId, 'Visible card'], [hiddenId, 'Card hidden from the phone']]) {
      expect(cards).toContainEqual(expect.objectContaining({ id, body }));
      expect(await tools.ok(client, 'read', { address: ROOM, facet: 'message', messageId: id }))
        .toMatchObject({ messageId: id, body });
    }
    expect(cards).not.toContainEqual(expect.objectContaining({ id: deletedId }));
    expect((await tools.call(client, 'read', { address: ROOM, facet: 'message', messageId: deletedId })).error).toBe(true);
  });

  it('renders one person tag with its context and attachment and replies by message id in a joined Claude session', async () => {
    vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
    const { client, member, token, grant } = await scope.connected();
    const seed = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'Save the image review procedure.' }, USER);
    const procedure = 'Measure the distance from each edge before giving feedback.';
    await applySkillRevision(scope.db, {
      workspaceId: WORKSPACE, sourceRoomId: ROOM, slug: 'image-review', kind: 'procedure',
      description: 'Review an annotated screenshot.', markdown: procedure, sourceMessageIds: [seed.messageId],
    });
    const brief = 'Review the keyboard alignment on the mobile layout.';
    await scope.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,spec,objective,author_id,source_room_id)
      VALUES($1,1,$2,'Review the layout',$3,$4)`, [PUBLIC_CORNER, brief, USER, ROOM]);
    await tools.ok(client, 'setup_delivery', {
      mechanism: 'local', host: 'Claude', surface: 'CLI', conversation: 'image-proof', installed: true,
    });
    const image={url:'https://files.example.test/browser-screen.jpg',name:'browser-screen.jpg',mimeType:'image/jpeg',size:176684,width:1080,height:2340};
    const dir = await mkdtemp(join(tmpdir(), 'tagged-image-session-'));
    const joined: JoinedSession = {
      key: 'claude-code:/image-proof', agent: 'claude-code', cwd: '/image-proof', name: 'Image proof',
      server: scope.origin, clientId: grant.clientId, cursor: '0', deliveredWakes: [], joinedAt: '',
    };
    const runner = { node: '/proof/node', bundle: '/proof/beeline.mjs' };
    const stream = memberStream(joined, token, AbortSignal.timeout(10_000));
    const instruction = 'Check the keyboard alignment in the attached image.';
    const text = `@${await handle(member)} follow image-review. ${'Context. '.repeat(2_000)}${instruction}`;
    let messageId: string | undefined;
    let rendered = 0;
    let tagCheckpoint = false;
    try {
      await updateState(dir, state => state.sessions.push(joined));
      for await (const raw of stream) {
        const frame = memberStreamFrame(raw);
        const count = await acceptMemberDelivery(dir, joined.key, runner, frame);
        if (messageId) rendered += count;
        if (frame.type !== 'checkpoint') continue;
        if (frame.mentionCursor !== '0') {
          tagCheckpoint = true;
          break;
        }
        if (!messageId) {
          takeInbox(dir, joined.key);
          const source = await scope.phone.execute('sendRoomMessage', { roomId: PUBLIC_CORNER, text, attachments: [image] }, USER);
          messageId = source.messageId;
        }
      }
      expect(tagCheckpoint).toBe(true);
      expect(rendered).toBe(1);
      const inbox = takeInbox(dir, joined.key);
      expect(inbox).toContain(`messageId: ${messageId}\n`);
      expect(inbox).toContain(instruction);
      expect(inbox).toContain(procedure);
      expect(inbox).toContain(brief);
      expect(inbox).toContain(image.name);
      expect(inbox).toContain(image.url);
      expect(inbox).toContain(image.mimeType);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const direct=await tools.ok(client,'read',{address:PUBLIC_CORNER,facet:'message',messageId});
    const page=await tools.ok(client,'read_messages',{room:PUBLIC_CORNER});
    const delivery=await tools.ok(client,'list_mentions',{});
    const command=(await readAgentCommands(scope.db,member)).commands.find(item=>item.sourceMessageId===messageId)!;
    expect((await scope.db.query('SELECT text FROM messages WHERE id=$1', [messageId])).rows).toEqual([{ text }]);
    expect(direct.body).toBe(text);
    expect(direct).not.toHaveProperty('nextOffset');
    expect(direct.attachments).toEqual([image]);
    expect(command.source.attachments).toEqual([image]);
    expect(itemPrompt(command,{names:new Map()})).toContain('📎 browser-screen.jpg (image/jpeg, 173 KB)');
    expect(page.items.find((item:{id:string})=>item.id===messageId)).toMatchObject({attachments:[image]});
    expect(delivery.mentions).toEqual([expect.objectContaining({
      id: messageId, messageId, commandId: command.id, text: text.slice(0, 16_000), truncated: true, attachments: [image],
    })]);
    expect(delivery.wakes).toEqual([]);
    const reply = await tools.ok(client, 'reply', { id: messageId, text: 'I checked the image.' });
    expect((await scope.db.query('SELECT room_id,card FROM messages WHERE id=$1', [reply.id])).rows)
      .toMatchObject([{ room_id: PUBLIC_CORNER, card: { route: { to: { agent: USER, place: PUBLIC_CORNER } } } }]);
  });
  it('names to and its {agent, place} shape when to is a string',async()=>{
    const {client}=await scope.connected();
    const refused=await client.callTool({name:'message',arguments:{to:'@ruby',text:'hi'}});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('to must be {agent, place}');
  });
  it('the SDK sends privately to one tuple and receives a reply at its sending place',async()=>{
    const {client,member}=await scope.connected();
    const sent=await tools.ok(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Check the widget'});
    expect(sent).toMatchObject({commandId: sent.id, messageId: sent.id, queued:true,
      destination:{agent:AGENT,place:ROOM},stored:true});
    expect(sent.id).toMatch(/^[0-9a-f]{64}$/);
    expect((await scope.db.query('SELECT agent_id,room_id,message FROM agent_commands WHERE id=$1',[sent.id])).rows)
      .toMatchObject([{agent_id:AGENT,room_id:ROOM,message:{route:{from:{agent:member,place:ROOM},to:{agent:AGENT,place:ROOM}},body:'Check the widget'}}]);
    await scope.daemon.execute('startAgentTurn',{roomId:ROOM,requestId:sent.id,invocationId:crypto.randomUUID()},AGENT);
    const response = await scope.daemon.execute('message',{type:'reply',roomId:ROOM,requestId:sent.id,quoteMsgId:sent.id,text:'Checked'},AGENT);
    expect(response).toMatchObject({queued:true,commandId:response.id,messageId:response.id,destination:{agent:member,place:ROOM}});
    await scope.daemon.execute('postRoomMessage',{roomId:ROOM,requestId:sent.id,text:''},AGENT);
    const page=await tools.ok(client,'list_mentions',{});
    expect(page.wakes).toEqual([expect.objectContaining({commandId:response.commandId,messageId:null,address:ROOM,from:{agent:AGENT,place:ROOM},text:'Checked'})]);
    // The session helper rejects a wake frame without a string reason.
    expect(typeof page.wakes[0]!.reason).toBe('string');
    expect(page.wakes[0].next).toContain('Reply needed: false\ntext: Checked');
    expect(page.wakes[0].next).not.toContain('Reply(id');
  });
  it('forwards report digests from connected message and reply tools', async () => {
    const {client,member}=await scope.connected();
    const digest={question:'Use the signed build?',brief:'Signing lets the check finish.',options:['Sign build','Wait']};
    const task=await humanTask(member);
    const reply=await tools.ok(client,'reply',{id:task.messageId,text:'blocked: Need a signed build.',...digest});
    const message=await tools.ok(client,'message',{address:ROOM,to:{agent:USER,place:ROOM},text:'needs-decision: Need a signed build.',...digest});
    for (const saved of [reply,message]) {
      const board = await scope.phone.execute('readWorkBoard', {workspaceId: (await scope.db.query('SELECT workspace_id FROM rooms WHERE id=$1',[ROOM])).rows[0]!.workspace_id}, USER);
      const item = board.items.find(item => item.messageId === saved.id)!;
      expect(item.brief).toBe(digest.brief);
      expect(item.ask?.approval?.actions.filter(action => action.kind === 'choice').map(action => action.label)).toEqual(digest.options);
    }
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
  it('keeps asks for separate tasks independent and records the recommended option',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    const ask={question:'Which proof?',options:['Server','Body'],recommended:'Server'};
    const first=await tools.ok(client,'reply',{id:task.id,text:'Choose a proof',ask});
    const next=await humanTask(member,'Inspect another widget');
    const second=await tools.ok(client,'reply',{id:next.id,text:'Choose another proof',ask});
    expect(first.id).not.toBe(second.id);
    expect((await scope.db.query('SELECT message_id,recommended_option_id FROM work_questions WHERE message_id=ANY($1::text[])',[ [first.id,second.id] ])).rows)
      .toEqual(expect.arrayContaining([{message_id:first.id,recommended_option_id:expect.any(String)},{message_id:second.id,recommended_option_id:expect.any(String)}]));
  });
  it('never selects another message when the supplied reply id is unavailable',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    const missing=await tools.call(client,'reply',{id:'0'.repeat(64),text:'Missing'});
    expect(missing.error).toBe(true);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'pending'}]);
    const other=await sendMessage(scope.db,{route:{from:{agent:USER,place:ROOM},to:{agent:AGENT,place:ROOM}},text:'For another member'});
    const local=await tools.call(client,'reply',{id:other.id,text:'Not mine'});
    expect(local.error).toBe(true);
    expect((await scope.db.query('SELECT id FROM messages WHERE text=ANY($1::text[])', [['Missing','Not mine']])).rows).toEqual([]);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[other.id])).rows).toEqual([{state:'pending'}]);
  });
  it('validates reply arguments before resolving the queued message or membership',async()=>{
    const {client,member}=await scope.connected();
    const task=await humanTask(member);
    const legacy=await tools.call(client,'reply',{address:ROOM,message:task.messageId});
    expect(legacy).toMatchObject({error:true});
    expect(legacy.text).toContain('reply: unknown fields: address, message');
    expect(legacy.text).not.toContain('membership');
    const missing=await tools.call(client,'reply',{text:'Missing message id'});
    expect(missing.text).toContain('reply: required: id');
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'pending'}]);
    await tools.ok(client,'reply',{id:task.messageId,text:'The widget works'});
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
    await scope.db.query('DELETE FROM agent_commands WHERE room_id=$1',[PUBLIC_CORNER]);
    const work=await tools.ok(client,'message',{address:ROOM,to:{agent:'implementer',place:PUBLIC_CORNER},text:'Check the widget'});
    await scope.daemon.execute('startAgentTurn',{roomId:PUBLIC_CORNER,requestId:work.id,invocationId:crypto.randomUUID()},AGENT);
    await scope.daemon.execute('message',{type:'reply',roomId:PUBLIC_CORNER,requestId:work.id,quoteMsgId:work.id,text:'Checked'},AGENT);
    await scope.daemon.execute('postRoomMessage',{roomId:PUBLIC_CORNER,requestId:work.id,text:''},AGENT);
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
      expect(await tools.call(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Atomic request'}))
        .toEqual({error:true,text:'The request failed.'});
    } finally {await scope.db.query('DROP TRIGGER reject_message ON agent_commands; DROP FUNCTION reject_message()');}
    expect((await scope.db.query("SELECT 1 FROM agent_commands WHERE private_payload->'route'->'from'->>'agent'=$1",[member])).rowCount).toBe(0);
    const sent=await tools.ok(client,'message',{address:ROOM,to:{agent:AGENT,place:ROOM},text:'Atomic request'});
    expect((await scope.db.query('SELECT 1 FROM agent_commands WHERE id=$1',[sent.id])).rowCount).toBe(1);
  });
  it('refuses unavailable bindings before either send writes', async () => {
    const {client,member} = await scope.connected();
    const task = await humanTask(member);
    for (const commandId of [task.messageId,'0'.repeat(64)]) {
      expect((await tools.call(client,'post',{address:ROOM,commandId,text:'Invalid binding'})).text)
        .toContain('commandId is not an available command');
      expect((await tools.call(client,'message',{address:ROOM,commandId,to:{agent:USER,place:ROOM},text:'Invalid binding'})).error).toBe(true);
    }
    expect((await scope.db.query("SELECT 1 FROM messages WHERE author_id=$1 AND text='Invalid binding'",[member])).rowCount).toBe(0);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'pending'}]);
  });

  it('selects a public source across places even while another local request is pending', async () => {
    const {client,member} = await scope.connected();
    const other = await humanTask(member);
    const source = await scope.phone.execute('sendRoomMessage', {
      roomId:PUBLIC_CORNER, text:`@${await handle(member)} Check this thread`,
    }, USER);
    const reply = await tools.ok(client,'reply',{id:source.messageId,text:'Thread checked'});
    expect(reply).toMatchObject({completed:true,published:true,destination:{agent:USER,place:PUBLIC_CORNER}});
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[other.id])).rows).toEqual([{state:'pending'}]);
    const again = await tools.ok(client,'reply',{id:source.messageId,text:'Thread follow-up'});
    expect(again.messageId).not.toBe(reply.messageId);
  });

  it('uses the recorded reply address in both writers while delivery shows the sender', async () => {
    const {client,member} = await scope.connected();
    for (const agent of [member,AGENT]) {
      const wake = await sendMessage(scope.db,{route:{from:{agent:USER,place:ROOM},to:{agent,place:ROOM}},text:'Use my return place'});
      await scope.db.query("UPDATE agent_commands SET message=message || jsonb_build_object('replyAddress',$2::jsonb) WHERE id=$1",
        [wake.commandId, JSON.stringify({agent:USER,place:PUBLIC_CORNER})]);
      const saved = agent === member
        ? await tools.ok(client,'reply',{id:wake.commandId,text:'Connected reply'})
        : await (async () => {
          await scope.daemon.execute('startAgentTurn',{roomId:ROOM,requestId:wake.commandId!,invocationId:crypto.randomUUID()},agent);
          return scope.daemon.execute('message',{roomId:ROOM,requestId:wake.commandId,type:'reply',quoteMsgId:wake.commandId,text:'Native reply'},agent);
        })();
      expect(saved.destination).toEqual({agent:USER,place:PUBLIC_CORNER});
      const route = (await scope.db.query("SELECT message->'route' route FROM agent_commands WHERE id=$1",[wake.commandId])).rows[0]!;
      expect(route).toMatchObject({route:{from:{agent:USER,place:ROOM}}});
    }
  });

  it('keeps a reply owed when no public text survives and completes a committed question', async () => {
    const {client,member} = await scope.connected();
    const task = await humanTask(member);
    const empty = await tools.ok(client,'reply',{id:task.messageId,text:'<think>private reasoning</think>'});
    expect(empty).toMatchObject({answered:false,completed:false,published:false,commandId:task.id});
    expect(empty.messageId).toBeUndefined();
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows).toEqual([{state:'pending'}]);
    const question = await tools.ok(client,'reply',{id:task.messageId,text:'Which build?',ask:{question:'Which build?',options:['Stable','Next']}});
    expect(question).toMatchObject({completed:true,published:true,queued:false,commandId:task.id,messageId:expect.any(String)});
    expect((await scope.db.query('SELECT message_id FROM work_questions WHERE message_id=$1',[question.messageId])).rowCount).toBe(1);
  });

  it('discriminates progress from transcript publication', async () => {
    const {client} = await scope.connected();
    const receipt = await tools.ok(client,'post',{address:PUBLIC_CORNER,text:'Measuring',progress:true});
    expect(receipt).toEqual({effect:'progress',address:PUBLIC_CORNER,recorded:true});
    expect((await scope.db.query("SELECT 1 FROM messages WHERE presentation='message' AND text='Measuring'")).rowCount).toBe(0);
  });

  it('returns the shared newest-first page and accepts its continuation unchanged', async () => {
    const {client} = await scope.connected();
    const sent = Array.from({length:3}, () => crypto.randomUUID().replaceAll('-','').repeat(2));
    await scope.db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT message.id,$1,$2,message.body,(SELECT COALESCE(max(created_at),now()) FROM messages WHERE room_id=$1)
        + message.ordinal * interval '1 second'
      FROM unnest($3::text[],ARRAY['First','Second','Third']) WITH ORDINALITY message(id,body,ordinal)`,
      [ROOM,USER,sent]);
    const options = {address:ROOM,facet:'messages',limit:2};
    const newest = await tools.ok(client,'read',options);
    expect(newest.items.map((item:{messageId:string}) => item.messageId)).toEqual([sent[2],sent[1]]);
    expect(newest.next).toEqual({before:expect.any(String)});
    const next = await tools.ok(client,'read',{...options,cursor:newest.next});
    expect(next.items[0].messageId).toEqual(sent[0]);
    const legacy = await tools.ok(client,'read_messages',{room:ROOM,limit:2,cursor:newest.next});
    expect(legacy.items).toEqual(next.items);
    expect((await tools.ok(client,'read',{address:ROOM,facet:'message',messageId:sent[0],cursor:{offset:2}})).body).toBe('rst');
  });

  it('rejects advertised input violations before lookup and formats safe refusals once', async () => {
    const {client} = await scope.connected();
    for (const [name,args] of [
      ['post',{address:PRIVATE,text:123}],
      ['post',{address:PRIVATE,text:'x'.repeat(16_001)}],
      ['post',{address:PRIVATE,text:'Content',replyTo:123}],
      ['reply',{id:'not-a-delivery',text:{bad:'value'}}],
      ['read',{address:PRIVATE,facet:'messages',cursor:{offset:-1}}],
      ['read',{address:PRIVATE,facet:'messages',cursor:{before:'bad-cursor'}}],
    ] as const) {
      const refused = await tools.call(client,name,args);
      expect(refused.error).toBe(true);
      expect(refused.text).not.toMatch(/membership|woke this turn/);
    }
    expect((await tools.call(client,'reply',{id:'0'.repeat(64),text:'Unknown quote'})).text)
      .toBe('Request refused: Quote a message that woke this turn.');
    await scope.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[PUBLIC_CORNER]);
    try {
      expect((await tools.call(client,'post',{address:PUBLIC_CORNER,text:'Archived'})).text)
        .toBe('Request refused: address is archived.');
      expect((await tools.call(client,'post',{address:PRIVATE,text:'Private'})).text)
        .toBe('Request refused: address requires current membership.');
    } finally { await scope.db.query('UPDATE rooms SET archived_at=NULL WHERE id=$1',[PUBLIC_CORNER]); }
  });

});
