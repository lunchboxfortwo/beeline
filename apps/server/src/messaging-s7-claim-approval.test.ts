import { GitHubOperations } from './github-operations.js';
import { gitHubOperationsAssertCornerReviewerNotAuthor } from './github-operations-begin-identity.js';
import { it,expect,A,B,SHA,rootFixture,inReview,approve,say,commands,claim } from './test-support-corner-lifecycle.test-support.js';
it('S7: claim_thread preserves the reviewed head and never lets its author approve their own work',async()=>{
  const thread=await inReview();
  await approve(thread);
  const approval=async()=>(await rootFixture.db.query<{head_sha:string}>(
    'SELECT head_sha FROM corner_merge_approvals WHERE corner_id=$1',[thread])).rows;
  expect(await approval()).toEqual([{head_sha:SHA}]);
  await say(thread,'@goosy Take over implementation');
  const turn=(await commands(B,thread)).find(item=>item.reason==='human_tag')!;
  await claim(turn);
  await rootFixture.daemon.execute('becomeImplementer',{roomId:thread,requestId:turn.turnRequestId},B);
  expect(await approval()).toEqual([{head_sha:SHA}]);
  expect((await rootFixture.db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[thread])).rows)
    .toEqual([{implementer_agent_id:B}]);
  await expect(approve(thread,SHA,B)).rejects.toThrow();
  Object.assign(rootFixture.githubApp,{issuesRequest:async(_token:string,_repository:string,_method:string,path:string)=>
    path.includes('/commits?') ? [{commit:{author:{email:`${A.slice(0,16)}@users.noreply.github.com`},committer:{email:'github@example.org'}}}]
      : {commits:1,head:{sha:SHA}}});
  await expect(gitHubOperationsAssertCornerReviewerNotAuthor(rootFixture.github,thread,A)).rejects.toThrow('PR commit author');
});
