import { expect, it, H, A, B, R, C, id, rootFixture, commands, send, claim } from './test-support-agent-command.integration.test-support.js';
import { queueCornerMergeConflict } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { backfillThreadImplementers } from './corner-lifecycle.js';

it('keeps a merge-conflict wake on the recorded implementer after a person tags another agent', async () => {
  await send('@hoots Please inspect this', C);
  const headSha = 'f'.repeat(40);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({checks:'passing',pr:{number:32,headSha,title:'Conflict',url:'https://github.com/acme/repo/pull/32',mergeability:'dirty'}})]);
  const note = await send('Resolve the conflict', C);
  await expect(queueCornerMergeConflict(rootFixture.db, C, note.messageId)).resolves.toBe(true);
  expect((await commands(B,C)).map(command=>command.reason)).toContain('corner_merge_conflict');
  expect((await commands(A,C)).map(command=>command.reason)).not.toContain('corner_merge_conflict');
});

it('records the agent assigned by an opening order rather than its opener', async () => {
  await send('@goosy Open assigned work', R);
  const item=(await commands(B,R))[0]!;
  await claim(item);
  const opened=await rootFixture.daemon.execute('createCorner', {roomId:R,requestId:item.turnRequestId,
    name:'Assigned-work',objective:'Deliver assigned work',implementer:'hoots',
    brief:{spec:'Deliver assigned work',repositoryWork:false}},B);
  expect((await rootFixture.db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[opened.cornerId])).rows[0])
    .toEqual({implementer_agent_id:A});
  await send('@goosy A question for the opener',opened.cornerId);
  expect((await rootFixture.db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[opened.cornerId])).rows[0])
    .toEqual({implementer_agent_id:A});
});

it('initializes a human thread from its first person tag and changes only on become_implementer', async () => {
  await rootFixture.db.query(`UPDATE corner_facts SET implementer_agent_id=NULL WHERE corner_id=$1`,[C]);
  await send('@hoots First assignment', C);
  await send('@goosy A question', C);
  const recorded=async()=> (await rootFixture.db.query<{implementer_agent_id:string}>(
    'SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[C])).rows[0]!.implementer_agent_id;
  expect(await recorded()).toBe(A);
  const item=(await commands(B,C))[0]!;
  await claim(item);
  await rootFixture.daemon.execute('becomeImplementer',{roomId:C,requestId:item.turnRequestId},B);
  expect(await recorded()).toBe(B);
  await send('@hoots Another question',C);
  expect(await recorded()).toBe(B);
});

it('refuses PR/push credentials for another agent and permits them immediately after becoming implementer', async () => {
  await rootFixture.db.query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1',[C,B]);
  const service=new DaemonService(rootFixture.db,rootFixture.live,async()=>({token:'fixture-token',expiresAt:9999999999}));
  await expect(service.execute('getRoomGitHubToken',{roomId:C,write:true},A))
    .rejects.toThrow('Call become_implementer before pushing or opening a PR for this thread.');
  await expect(service.execute('getRoomGitHubToken',{roomId:C},A)).resolves.toEqual({token:'fixture-token',expiresAt:9999999999});
  await send('@hoots Take over',C);
  const item=(await commands(A,C))[0]!;
  await claim(item);
  await service.execute('becomeImplementer',{roomId:C,requestId:item.turnRequestId},A);
  await expect(service.execute('getRoomGitHubToken',{roomId:C,write:true},A)).resolves.toEqual({token:'fixture-token',expiresAt:9999999999});
});

it('backfills the old latest-tag derivation once and never overwrites an explicit takeover', async () => {
  await send('@hoots Latest tag',C);
  await rootFixture.db.query(`DELETE FROM beeline_release_steps WHERE name='thread-implementer-v1'`);
  await rootFixture.db.query('UPDATE corner_facts SET implementer_agent_id=NULL WHERE corner_id=$1',[C]);
  await backfillThreadImplementers(rootFixture.db);
  expect((await rootFixture.db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[C])).rows[0])
    .toEqual({implementer_agent_id:A});
  await rootFixture.db.query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1',[C,B]);
  await backfillThreadImplementers(rootFixture.db);
  expect((await rootFixture.db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[C])).rows[0])
    .toEqual({implementer_agent_id:B});
});
