import { afterAll, beforeAll, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase, insertCornerFacts } from './test-support.js';
import { messageAsksSql } from './message-asks.js';
import { loadCornerReviewState } from './corner-lifecycle-review-state.js';
import type { SqlDatabase } from './database.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const human = 'a'.repeat(64), worker = 'b'.repeat(64), reviewer = 'c'.repeat(64);
const head = 'd'.repeat(40);
let db: PgliteDatabase;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'agent','Worker'),($3,'agent','Reviewer')`, [human,worker,reviewer]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [worker,reviewer,human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'History proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
    ($1,$3,NULL,'Parent'),($2,$3,$1,'Thread')`, [room,corner,workspace]);
  for (const identity of [human,worker,reviewer])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`, [workspace,room,identity]);
  await insertCornerFacts(db,{cornerId:corner});
  await db.query(`UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1`, [corner,worker]);
  await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [room,reviewer]);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [corner,JSON.stringify({checks:'passed',pr:{number:9,headSha:head}})]);
  // Unrelated historical work by the same reviewer must never be searched for
  // one thread's questions or one command's verdict. No live sources are run.
  await db.query('ALTER TABLE messages DISABLE TRIGGER USER');
  await db.query('ALTER TABLE agent_commands DISABLE TRIGGER USER');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text)
    SELECT 'history-'||n,$1,$2,'Unrelated completed review '||n FROM generate_series(1,30000) n`, [room,reviewer]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state,private_payload)
    SELECT 'history-'||n,$1,$2,'history-turn-'||n,'input','message','history-'||n,'history-1',0,'complete',
      jsonb_build_object('text','Unrelated history '||n) FROM generate_series(1,30000) n`, [room,reviewer]);
  await db.query('ALTER TABLE messages ENABLE TRIGGER USER');
  await db.query('ALTER TABLE agent_commands ENABLE TRIGGER USER');
  await db.query('ANALYZE');
}, 60_000);
afterAll(async () => db?.close());

it('finds an originating message question and its reply without scanning command history', async () => {
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,agent_depth,state,private_payload)
    VALUES('question',$1,$2,'question-turn','input','message','question','history-1',0,'complete',$3)`,
    [room,reviewer,JSON.stringify({messageAsk:{question:'Which?'},route:{from:{agent:worker,place:corner}}})]);
  const sql = `SELECT question.report_id FROM rooms origin
    CROSS JOIN LATERAL (${messageAsksSql('origin')}) question WHERE origin.id=$1`;
  expect((await db.query(sql,[corner])).rows).toEqual([{report_id:'question'}]);
  const plan = (await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,[corner])).rows[0]!['QUERY PLAN'][0].Plan;
  expect(plan['Shared Hit Blocks']+plan['Shared Read Blocks']).toBeLessThan(100);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,agent_depth,state,private_payload)
    VALUES('answer',$1,$2,'answer-turn','input','message','answer','history-1',0,'complete',$3)`,
    [corner,worker,JSON.stringify({inReplyTo:'question',route:{from:{agent:reviewer,place:room}}})]);
  expect((await db.query(sql,[corner])).rows).toEqual([]);
});

it.each(['result','request','report','private'] as const)('reads a %s review verdict through recorded IDs without scanning the author history', async mode => {
  const command = `review-${mode}`, verdict = `verdict-${mode}`, request = `request-${mode}`;
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,agent_depth,state,result_message_id,review_context)
    VALUES($1,$2,$3,$4,'input','corner_review_dispatch',$1,'history-1',0,'complete',$5,$6)`,
    [command,corner,reviewer,request,mode==='result'?verdict:null,
      JSON.stringify({headSha:head,pullRequest:9,checks:{status:'passing'},reportIds:mode==='report'||mode==='private'?[verdict]:[]})]);
  if (mode==='private') await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state,private_payload)
      VALUES($1,$2,$3,$1,'input','message',$1,'history-1',0,'complete',$4)`,
    [verdict,room,worker,JSON.stringify({authorId:reviewer,text:'FAIL: recorded verdict'})]);
  else await db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
    VALUES($1,$2,$3,'FAIL: recorded verdict',$4)`, [verdict,corner,reviewer,mode==='request'?request:null]);
  let buffers = Infinity;
  const measured: SqlDatabase = {
    query: async (sql,values) => {
      const plan = (await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,values)).rows[0]!['QUERY PLAN'][0].Plan;
      buffers = plan['Shared Hit Blocks']+plan['Shared Read Blocks'];
      return db.query(sql,values);
    },
    transaction: work => db.transaction(work),
  };
  const result = await loadCornerReviewState(measured,corner,head);
  expect(result.ended?.findings).toBe('FAIL: recorded verdict');
  expect(buffers).toBeLessThan(400);
});
