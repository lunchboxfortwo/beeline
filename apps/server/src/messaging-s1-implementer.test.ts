import { describe,it,expect,A,B,SHA,rootFixture,open,inReview,say,advanceCorner,fixtureScope18,pushToCorner } from './test-support-corner-lifecycle.test-support.js';
import { queueCornerMergeConflict,type CommandRow } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
const pending=async()=> (await rootFixture.db.query<{agent_id:string;room_id:string;reason:string}>(
  "SELECT agent_id,room_id,reason FROM agent_commands WHERE state='pending' AND reason<>'mcp_call' ORDER BY created_at,id")).rows;
const settle=()=>rootFixture.db.query("UPDATE agent_commands SET state='complete' WHERE state='pending'");
describe('S1: repair wakes keep the recorded implementer after another person tag',()=>{
  it.each(['conflict','checks','refusal'] as const)('%s wakes only the implementer at the thread address',async cause=>{
    const thread=await open('owner/widgets');
    await say(thread,'@goosy Look at this');
    await settle();
    await rootFixture.db.query('UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1',[thread,
      JSON.stringify({lifecycle:'in-review',checks:'unknown',pr:{number:7,headSha:SHA,url:'https://github.com/owner/widgets/pull/7'}})]);
    await pushToCorner(thread,SHA);
    if(cause==='conflict') {
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,mergeability}','"dirty"') WHERE corner_id=$1`,[thread]);
      await say(thread,'Resolve this conflict');
      const note=(await rootFixture.db.query<{id:string}>('SELECT id FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1',[thread])).rows[0]!;
      await queueCornerMergeConflict(rootFixture.db,thread,note.id);
    } else if(cause==='checks') {
      rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({state:'failed',total:1,failing:['typecheck'],checks:[{name:'typecheck',status:'failed'}]});
      await fixtureScope18().checkRun(thread,'typecheck','failure');
    } else await advanceCorner(rootFixture.db,thread,{kind:'merge-refused',headSha:SHA,reason:'Provider refused the merge'});
    expect(await pending()).toEqual([{agent_id:A,room_id:thread,reason:{conflict:'corner_merge_conflict',checks:'corner_check',refusal:'corner_merge_refused'}[cause]}]);
  });
  it('review findings are delivered only to the implementer at the thread address',async()=>{
    const thread=await inReview();
    const review=(await rootFixture.db.query<CommandRow>("SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_dispatch'",[thread,B])).rows[0]!;
    await say(thread,'@goosy A later question');
    await settle();
    await sendMessage(rootFixture.db,{route:{from:{agent:B,place:thread},to:{agent:A,place:thread}},text:'FAIL: fix the missing test',parent:review});
    await advanceCorner(rootFixture.db,thread,{kind:'reconcile'});
    expect(await pending()).toEqual([{agent_id:A,room_id:thread,reason:'message'}]);
    const delivered=(await rootFixture.db.query<CommandRow>("SELECT * FROM agent_commands WHERE state='pending'")).rows[0]!;
    expect(delivered.message?.body).toContain('FAIL: fix the missing test');
  });
});
