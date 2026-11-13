import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('durable agent queue on PostgreSQL', () => {
  const human = 'a'.repeat(64), agent = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID();
  let fixture: Awaited<ReturnType<typeof groupBPostgresDatabase>>, daemon: DaemonService;
  beforeAll(async () => {
    fixture = await groupBPostgresDatabase(url!);
    const db = fixture.database;
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent')`, [human,agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent,human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queue')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Queue')`, [room,workspace]);
    for (const person of [human,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace,room,person]);
    daemon = new DaemonService(db,new LiveHub());
  }, 60_000);
  afterAll(async () => fixture?.close());
  async function ask(text: string) {
    const source = randomBytes(32).toString('hex');
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,$4,'message')`,
      [source,room,human,text]);
    return (await createAgentCommand(fixture.database,{roomId:room,agentId:agent,sourceMessageId:source,reason:'human_tag'}))!;
  }
  const answer = (requestId: string) => daemon.execute('postRoomMessage',{roomId:room,requestId,text:'durable answer'},agent);

  it('commits one answer and its done state together even with concurrent duplicate delivery', async () => {
    const item = await ask('concurrent delivery');
    const [first,second] = await Promise.all([answer(item.turn_request_id),answer(item.turn_request_id)]);
    expect(first.id).toBe(second.id);
    expect((await fixture.database.query(`SELECT state,result_message_id,completed_at IS NOT NULL done FROM agent_commands WHERE id=$1`,[item.id])).rows)
      .toEqual([{state:'complete',result_message_id:first.id,done:true}]);
    expect((await fixture.database.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,[agent,item.turn_request_id])).rows)
      .toEqual([{n:1}]);
  });

  it('keeps an item queued when posting fails and completes it only after a later successful post', async () => {
    const item = await ask('failed delivery');
    await fixture.database.query(`CREATE FUNCTION refuse_queue_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.author_id='${agent}' THEN RAISE EXCEPTION 'injected answer write failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER refuse_queue_answer BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION refuse_queue_answer()`);
    try {
      await expect(answer(item.turn_request_id)).rejects.toThrow('injected answer write failure');
      expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>command.id)).toContain(item.id);
      expect((await fixture.database.query('SELECT completed_at FROM agent_commands WHERE id=$1',[item.id])).rows)
        .toEqual([{completed_at:null}]);
    } finally {
      await fixture.database.query('DROP TRIGGER refuse_queue_answer ON messages; DROP FUNCTION refuse_queue_answer()');
    }
    await answer(item.turn_request_id);
    expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>command.id)).not.toContain(item.id);
  });

  it('cannot answer a stopped item', async () => {
    const item = await ask('stopped delivery');
    await fixture.database.query(`SELECT beeline_finish_agent_command($1,'cancelled','stop',NULL)`,[item.id]);
    await expect(answer(item.turn_request_id)).rejects.toThrow('command turn cancelled');
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE author_id=$1 AND request_id=$2`,[agent,item.turn_request_id])).rowCount).toBe(0);
  });
});
