import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { parseTaggedAgentLifecycleCommand } from './agent-command.js';
import { announceAgentLifecycle } from './connection-presence.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { routeHumanMessage } from './test-fixtures/queue-routing.test-support.js';
import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { PgliteDatabase,migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);

describe('tagged agent lifecycle commands', () => {
  let database: PgliteDatabase;
  let live: LiveHub;

  beforeEach(async () => {
    database = await migratedDatabase();
    live = new LiveHub();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Bee','bee')`,
      [OWNER, MEMBER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [WORKSPACE, ROOM, OWNER, MEMBER, AGENT],
    );
    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-1' });
  });

  afterEach(async () => database.close());

  async function send(id: string, author: string, text: string) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      id,
      ROOM,
      author,
      text,
    ]);
    await routeHumanMessage(database, id);
  }

  it('parses only an exact tagged command', () => {
    expect(parseTaggedAgentLifecycleCommand('@bee restart', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand('@bee /restart', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand(' @BEE /RESTART ', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand(' @BEE STATUS ', 'bee')).toBe('status');
    expect(parseTaggedAgentLifecycleCommand('@bee /status', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee /restart please', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee restart please', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('restart @bee', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@other restart', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee login', 'bee')).toBe('login');
    expect(parseTaggedAgentLifecycleCommand(' @Bee /LOGIN ', 'bee')).toBe('login');
    expect(parseTaggedAgentLifecycleCommand('@bee login now', 'bee')).toBeUndefined();
  });


  it.each(['restart','/restart','status','retry','debug','help','login','/login'])('delivers @bee %s as ordinary agent input',async command=>{
    const id='1'.repeat(64);
    await send(id,MEMBER,`@bee ${command}`);
    expect((await database.query('SELECT action,state,message FROM agent_commands')).rows).toEqual([
      {action:'input',state:'pending',message:expect.objectContaining({body:`@bee ${command}`,authorId:MEMBER})}]);
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
    await announceAgentLifecycle(database,live,ROOM,AGENT,{lifecycleId:'boot-2'});
    expect((await database.query('SELECT state FROM agent_commands')).rows).toEqual([{state:'pending'}]);
  });

  it('a reconnect resend deduplicates its source, while a separate restart request stays distinct',async()=>{
    const phone=new PhoneService(database,'http://test');
    for(const id of ['1'.repeat(64),'1'.repeat(64),'2'.repeat(64)])
      await phone.execute('sendRoomMessage',{roomId:ROOM,messageId:id,text:'@bee restart'},MEMBER);
    expect((await database.query("SELECT 1 FROM agent_commands WHERE state='pending' AND action='input'")).rowCount).toBe(2);
  });

  it('offline control prose stays queued without a server-generated answer',async()=>{
    await database.query("DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'",[AGENT]);
    await send('1'.repeat(64),MEMBER,'@bee status');
    expect((await database.query("SELECT 1 FROM agent_commands WHERE state='pending'")).rowCount).toBe(1);
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
  });

  it('exact tagged Stop cancels pending work; a later retry is another ordinary request',async()=>{
    await send('1'.repeat(64),MEMBER,'@bee work');
    const item=(await database.query<{id:string}>('SELECT id FROM agent_commands')).rows[0]!;
    await startQueuedTurn(database,ROOM,AGENT,item.id);
    await send('2'.repeat(64),MEMBER,'@bee stop');
    expect((await database.query('SELECT state FROM agent_commands WHERE id=$1',[item.id])).rows).toEqual([{state:'cancelled'}]);
    expect((await database.query("SELECT status FROM agent_turns")).rows).toEqual([{status:'cancelled'}]);
    await send('3'.repeat(64),MEMBER,'@bee retry');
    expect((await database.query("SELECT action,state FROM agent_commands WHERE source_message_id=$1",['3'.repeat(64)])).rows)
      .toEqual([{action:'input',state:'pending'}]);
    expect((await database.query("SELECT 1 FROM agent_commands WHERE action='stop'")).rowCount).toBe(0);
  });
});
