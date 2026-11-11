import {
  describe, expect, it, advanceCorner, createAgentCommand, reconcileConfiguredCornerReviewers,
  H, A, B, W, R, C, commands, claim, result, greenHead, rootFixture,
} from './test-support-corner-review-dispatch.test-support.js';

describe('revision 4 simple corner review model', () => {
  it('Reproduction REVIEW-EMPTY: ends an empty green review once with a visible cause and no retry', async () => {
    await rootFixture.phone.execute('updateRoom', {roomId:R,reviewerAgentId:B},H);
    await greenHead(104,'4'.repeat(40));
    const [first] = await commands(B,C);
    await claim(first!);
    await rootFixture.daemon.execute('postAgentTurnReceipt', {
      roomId:C,requestId:first!.turnRequestId,generationId:'g1',status:'complete',
    },B);
    for(let replay=0;replay<3;replay++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    expect(await commands(B,C)).toEqual([]);
    const lines = (await rootFixture.db.query<{text:string}>(
      `SELECT text FROM messages WHERE room_id=$1`,[C])).rows;
    expect(lines.some(line=>line.text.includes('reviewer gave no verdict'))).toBe(true);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND reason='corner_review_dispatch'`,[C,B])).rowCount).toBe(1);
  });

  it('C-2: a completed FAIL cannot veto a new green event on the same head', async () => {
    const head='5'.repeat(40);
    await rootFixture.phone.execute('updateRoom', {roomId:R,reviewerAgentId:B},H);
    await greenHead(105,head);
    const [review]=await commands(B,C);
    await claim(review!);
    await result(review!,'FAIL: repair the implementation.');
    await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    const fixes=await commands(A,C);
    for(const fix of fixes) {
      await claim(fix);
      await result(fix,'The requested correction is ready.');
    }
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[C]);
    await advanceCorner(rootFixture.db,C,{kind:'checks-pending'});
    await greenHead(105,head);
    const next=(await commands(B,C)).filter(command=>command.reason==='corner_review_dispatch');
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(review!.id);
  });
  it('C-2: peer activity retains Working without suppressing the green-head review', async () => {
    const peer='d'.repeat(64);
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Peer','peer')`,[peer]);
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[peer,H]);
    for(const room of [null,R]) await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,room,peer]);
    await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
    await createAgentCommand(rootFixture.db,{roomId:C,agentId:peer,sourceMessageId:null,reason:'order',
      privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Answer an unrelated question'}});
    await claim((await commands(peer,C))[0]!);
    await greenHead(106,'6'.repeat(40));
    expect((await commands(B,C)).filter(command=>command.reason==='corner_review_dispatch')).toHaveLength(1);
    expect((await rootFixture.db.query(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`,[C])).rows)
      .toEqual([{state:'working'}]);
  });

  it('C-2: a green handoff during same-head repair dispatches after the implementer finishes', async () => {
    const head='7'.repeat(40);
    await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
    await greenHead(107,head);
    const [first]=await commands(B,C);
    await claim(first!);
    await result(first!,'FAIL: attach the required evidence.');
    await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    const [repair]=(await commands(A,C)).filter(command=>command.reason==='corner_review_needed');
    expect(repair).toBeDefined();
    await claim(repair!);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[C]);
    await advanceCorner(rootFixture.db,C,{kind:'checks-pending'});
    await greenHead(107,head);
    expect(await commands(B,C)).toEqual([]);
    await result(repair!,'The requested evidence is attached; the head is unchanged.');
    for(let event=0;event<3;event++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    const next=(await commands(B,C)).filter(command=>command.reason==='corner_review_dispatch');
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(first!.id);
    expect(next[0]!.source.body).toContain(head);
    for(let event=0;event<3;event++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    expect((await commands(B,C)).map(command=>command.id)).toEqual(next.map(command=>command.id));
  });

});

it('Reproduction REVIEW-TARGET: a new head wake uses the newest brief and reported verdict', async () => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  await greenHead(104,'1'.repeat(40));
  const [review]=await commands(B,C);
  await claim(review!);
  await rootFixture.daemon.execute('report',{roomId:C,requestId:review!.turnRequestId,generationId:'g1',
    status:'failed',text:'FAIL: newest reported evidence'},B);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{roomId:C,requestId:review!.turnRequestId,generationId:'g1',status:'complete'},B);
  await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
    VALUES($1,2,'New brief','New brief',$2,$3)`,[C,A,R]);
  await greenHead(104,'2'.repeat(40));
  const [next]=await commands(B,C);
  expect(next?.source.body).toContain('Review against brief revision 2');
  expect(next?.source.body).toContain('2'.repeat(40));
  expect(next?.source.body).toContain('FAIL: newest reported evidence');
});

it('Reproduction REVIEW-ORDER: ordering the listed reviewer works and an archived corner says archived', async () => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  const current=await createAgentCommand(rootFixture.db,{roomId:C,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Implement the fix'}});
  const worker=(await commands(A,C)).find(c=>c.id===current!.id)!;
  await claim(worker);
  const args={roomId:C,requestId:worker.turnRequestId,generationId:'g1',address:C,agent:'goosy',text:'Review this fix'};
  await rootFixture.daemon.execute('order',args,A);
  expect((await commands(B,C)).some(c=>c.reason==='order')).toBe(true);
  // Use a reachable archived sibling; the source turn remains live.
  const archived='44444444-4444-4444-8444-444444444444';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
    VALUES($1,$2,$3,'Archived corner',now())`,[archived,W,R]);
  await expect(rootFixture.daemon.execute('order',{...args,address:archived},A)).rejects.toThrow('archived');
});
