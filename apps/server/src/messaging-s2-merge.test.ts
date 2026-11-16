import { it,expect,B,H,SHA,rootFixture,inReview,branchOf,approve } from './test-support-corner-lifecycle.test-support.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
const queueIds=async()=> (await rootFixture.db.query<{id:string}>('SELECT id FROM agent_commands')).rows.map(row=>row.id);
const added=async(before:string[])=>(await rootFixture.db.query<{agent_id:string;room_id:string}>(
  'SELECT agent_id,room_id FROM agent_commands WHERE NOT(id=ANY($1::text[]))',[before])).rows;
const wired=()=>{ const daemon=new DaemonService(rootFixture.db,new LiveHub(),undefined,undefined,false,undefined,false,undefined,
  (input,confirm)=>rootFixture.github.prChecksStatus(input,confirm),undefined,undefined,undefined,undefined,undefined,undefined,
  undefined,undefined,undefined,(id,blocked)=>rootFixture.github.landCornerOutcome(id,blocked));
  Object.assign(daemon,{github:rootFixture.github});return daemon;};
it('S2: reviewer yes and green merge without a brief or an agent wake; a hold release opens the same gate',async()=>{
  // https://github.com/Beeline-Work/beeline/pull/72: reviewer yes was stranded without a brief.
  const thread=await inReview();
  await rootFixture.db.query('DELETE FROM corner_brief_revisions WHERE corner_id=$1',[thread]);
  const phone=new PhoneService(rootFixture.db,'http://test',rootFixture.github);
  const hold=await phone.execute('setCornerHold',{cornerId:thread},H);
  const before=await queueIds();
  await wired().execute('approveCornerMerge',{cornerId:thread,headSha:SHA},B);
  expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  expect(await added(before)).toEqual([]);
  await phone.execute('setCornerHold',{cornerId:thread,releaseHoldId:hold.holdId},H);
  expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  expect(await added(before)).toEqual([]);
});
it('S2: green after yes merges without an agent wake',async()=>{
  const thread=await inReview();
  rootFixture.githubRollupState='pending';
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[thread]);
  await wired().execute('approveCornerMerge',{cornerId:thread,headSha:SHA},B);
  expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
  const before=await queueIds();
  rootFixture.githubRollupState='passed';
  await rootFixture.github.processWebhook('check_run',{action:'completed',installation:{id:77},repository:{full_name:'owner/widgets'},
    check_run:{id:71,name:'typecheck',status:'completed',conclusion:'success',head_sha:SHA,check_suite:{head_branch:branchOf(thread)}}});
  expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  expect(await added(before)).toEqual([]);
 });
it('S2: a changed provider head voids the recorded approval',async()=>{
  const thread=await inReview();
  await approve(thread);
  const next='8'.repeat(40);
  rootFixture.githubHead=next;
  expect(await rootFixture.github.prChecksStatus({cornerId:thread})).toMatchObject({headSha:next,approved:false,mergeAllowed:false});
  expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
});
