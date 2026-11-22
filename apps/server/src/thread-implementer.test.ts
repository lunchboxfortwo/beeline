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

it('initializes a human thread from its first person tag and changes only on claim_thread', async () => {
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

it('P1: grants claimed thread pushes against the parent repository, including legacy chat requests', async () => {
  // Earlier cases can leave other threads; isolate this claim's authority.
  await rootFixture.db.query('UPDATE corner_facts SET implementer_agent_id=NULL');
  await rootFixture.db.query('UPDATE corner_facts SET implementer_agent_id=$2 WHERE corner_id=$1',[C,B]);
  const tokenRooms: string[] = [];
  const credential = {token:'fixture-token',expiresAt:9999999999};
  const service=new DaemonService(rootFixture.db,rootFixture.live,async roomId=>{
    tokenRooms.push(roomId);
    return credential;
  });
  for (const roomId of [C, R]) {
    await expect(service.execute('getRoomGitHubToken',{roomId,write:true},A))
      .rejects.toThrow('Call claim_thread before pushing or opening a PR for this thread.');
  }
  expect(tokenRooms).toEqual([]);
  // Read requests retain their existing address and do not require a claim.
  for (const roomId of [C, R]) {
    await expect(service.execute('getRoomGitHubToken',{roomId},A)).resolves.toEqual(credential);
  }
  expect(tokenRooms.splice(0)).toEqual([C, R]);
  await send('@hoots Take over',C);
  const item=(await commands(A,C))[0]!;
  await claim(item);
  await service.execute('becomeImplementer',{roomId:C,requestId:item.turnRequestId},A);
  for (const roomId of [C, R]) {
    await expect(service.execute('getRoomGitHubToken',{roomId,write:true},A)).resolves.toEqual(credential);
  }
  expect(tokenRooms.splice(0)).toEqual([R, R]);
  for (const roomId of [C, R]) {
    await expect(service.execute('getRoomGitHubToken',{roomId,write:true},B)).rejects.toThrow('Call claim_thread');
  }
  // An open claim in another chat does not authorize this chat's repository.
  const otherChat = '55555555-5555-4555-8555-555555555555';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name)
    SELECT $1,workspace_id,'Other chat' FROM rooms WHERE id=$2`,[otherChat,R]);
  await rootFixture.db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[C,otherChat]);
  await expect(service.execute('getRoomGitHubToken',{roomId:R,write:true},A)).rejects.toThrow('Call claim_thread');
  await rootFixture.db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[C,R]);
  // A sibling's implementer cannot use that claim for this specific thread.
  const sibling = '44444444-4444-4444-8444-444444444444';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name)
    SELECT $1,workspace_id,parent_id,'Sibling' FROM rooms WHERE id=$2`,[sibling,C]);
  await expect(service.execute('getRoomGitHubToken',{roomId:sibling,write:true},A))
    .rejects.toThrow('Call claim_thread');
  await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[C]);
  for (const roomId of [C, R]) {
    await expect(service.execute('getRoomGitHubToken',{roomId,write:true},A)).rejects.toThrow('Call claim_thread');
  }
  expect(tokenRooms).toEqual([]);
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

it('lets a commander claim a thread from its parent chat and refuses the reviewer', async () => {
  const recorded=async()=> (await rootFixture.db.query<{implementer_agent_id:string}>(
    'SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[C])).rows[0]!.implementer_agent_id;
  expect(await recorded()).toBe(B);
  await send('@hoots Take this thread', R);
  const fromChat=(await commands(A,R))[0]!;
  await claim(fromChat);
  await rootFixture.daemon.execute('becomeImplementer',{roomId:R,requestId:fromChat.turnRequestId,cornerId:C},A);
  expect(await recorded()).toBe(A);
  // The chat itself is not a thread to claim.
  await expect(rootFixture.daemon.execute('becomeImplementer',{roomId:R,requestId:fromChat.turnRequestId},A))
    .rejects.toThrow('claim_thread needs a thread address.');
  // The configured reviewer is refused, whether it claims from the thread or the parent chat.
  await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1',[R,B]);
  await send('@goosy Review this thread', C);
  const review=(await commands(B,C))[0]!;
  await claim(review);
  await expect(rootFixture.daemon.execute('becomeImplementer',{roomId:C,requestId:review.turnRequestId},B))
    .rejects.toThrow('The thread reviewer cannot claim the implementer role.');
  await send('@goosy Claim it from here', R);
  const reviewerInChat=(await commands(B,R))[0]!;
  await claim(reviewerInChat);
  await expect(rootFixture.daemon.execute('becomeImplementer',{roomId:R,requestId:reviewerInChat.turnRequestId,cornerId:C},B))
    .rejects.toThrow('The thread reviewer cannot claim the implementer role.');
  expect(await recorded()).toBe(A);
});
