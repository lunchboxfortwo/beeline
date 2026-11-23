import {
  describe, expect, it, advanceCorner, createAgentCommand, reconcileConfiguredCornerReviewers,
  H, A, B, W, R, C, commands, claim, result, greenHead, rootFixture,
} from './test-support-corner-review-dispatch.test-support.js';

describe('revision 4 simple corner review model', () => {
  it('Reproduction REVIEW-EMPTY: keeps an unanswered green review queued without appending a retry', async () => {
    await rootFixture.phone.execute('updateRoom', {roomId:R,reviewerAgentId:B},H);
    await greenHead(104,'4'.repeat(40));
    const [first] = await commands(B,C);
    await claim(first!);
    await rootFixture.daemon.execute('postAgentTurnReceipt', { roomId:C, requestId:first!.turnRequestId, status:'complete' },B);
    for(let replay=0;replay<3;replay++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    expect((await commands(B,C)).map(item=>item.id)).toEqual([first!.id]);
    const lines = (await rootFixture.db.query<{text:string}>(
      `SELECT text FROM messages WHERE room_id=$1`,[C])).rows;
    expect(lines.some(line=>line.text.includes('reviewer gave no verdict'))).toBe(false);
    expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1',[first!.turnRequestId])).rows)
      .toEqual([{status:'working'}]);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND reason='corner_review_dispatch'`,[C,B])).rowCount).toBe(1);
  });

  it('C-2: a completed FAIL ends automatic review of the same head and brief revision', async () => {
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
      await result(fix,'');
    }
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[C]);
    await advanceCorner(rootFixture.db,C,{kind:'checks-pending'});
    await greenHead(105,head);
    expect((await commands(B,C)).filter(command=>command.reason==='corner_review_dispatch')).toEqual([]);
  });
  it('C-2: unrelated peer activity preserves Review and the green-head review dispatch', async () => {
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
      .toEqual([{state:'review'}]);
  });

  it('C-2: a green handoff during same-head repair queues no automatic review of the verdicted head', async () => {
    const head='7'.repeat(40);
    await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
    await greenHead(107,head);
    const [first]=await commands(B,C);
    await claim(first!);
    await result(first!,'FAIL: attach the required evidence.');
    await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    const [repair]=(await commands(A,C)).filter(command=>command.reason==='reply');
    expect(repair).toBeDefined();
    await claim(repair!);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`,[C]);
    await advanceCorner(rootFixture.db,C,{kind:'checks-pending'});
    await greenHead(107,head);
    expect(await commands(B,C)).toEqual([]);
    await result(repair!,'');
    for(let event=0;event<3;event++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
    // Another review of this head is an explicit request (RUBY-18).
    expect(await commands(B,C)).toEqual([]);
  });

});

it('Reproduction REVIEW-TARGET: a new head wake uses the newest brief and reported verdict', async () => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  await greenHead(104,'1'.repeat(40));
  const [review]=await commands(B,C);
  await claim(review!);
  await rootFixture.daemon.execute('report',{ roomId:C, requestId:review!.turnRequestId, status:'failed', text:'FAIL: newest reported evidence' },B);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{ roomId:C, requestId:review!.turnRequestId, status:'complete' },B);
  await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
    VALUES($1,2,'New brief','New brief',$2,$3)`,[C,A,R]);
  await greenHead(104,'2'.repeat(40));
  const [next]=await commands(B,C);
  // The helper renders the newest brief and head at delivery; the body names neither.
  expect(next?.source.body).not.toMatch(/brief revision|handoff target/i);
  expect((await rootFixture.db.query(`SELECT review_context->>'headSha' head FROM agent_commands WHERE id=$1`,[next!.id])).rows[0]).toEqual({head:'2'.repeat(40)});
  expect(next?.source.body).toContain('FAIL: newest reported evidence');
});

it('Reproduction REVIEW-ORDER: ordering the listed reviewer works and an archived thread says archived', async () => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  const current=await createAgentCommand(rootFixture.db,{roomId:C,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Implement the fix'}});
  const worker=(await commands(A,C)).find(c=>c.id===current!.id)!;
  await claim(worker);
  const args={ roomId:C, requestId:worker.turnRequestId, address:C, agent:'goosy', text:'Review this fix' };
  await rootFixture.daemon.execute('order',args,A);
  expect((await commands(B,C)).some(c=>c.reason==='order')).toBe(true);
  // Use a reachable archived sibling; the source turn remains live.
  const archived='44444444-4444-4444-8444-444444444444';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
    VALUES($1,$2,$3,'Archived corner',now())`,[archived,W,R]);
  await expect(rootFixture.daemon.execute('order',{...args,address:archived},A)).rejects.toThrow('archived');
});

it.each(['reply','silent'])('Reproduction REVIEW-EMPTY-HANDBACK: a %s review with no verdict hands back to the implementer once, privately', async ending => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  await greenHead(108,'8'.repeat(40));
  const [review]=await commands(B,C);
  await claim(review!);
  if(ending==='reply') {
    await result(review!,'The review is complete.');
    const [reply]=(await commands(A,C)).filter(command=>command.reason==='reply');
    await claim(reply!);
    await result(reply!,'');
  } else await rootFixture.db.query(`SELECT beeline_finish_agent_command($1,'complete',NULL,NULL)`,[review!.id]);
  for(let replay=0;replay<3;replay++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  const handback=(await commands(A,C)).filter(command=>command.reason==='corner_review_needed');
  expect(handback).toHaveLength(1);
  expect(handback[0]!.source.body).toContain('the reviewer gave no verdict; arrange review or report the blocker to its commander');
  expect(handback[0]!.source.body).not.toContain('FAIL');
  const lines=(await rootFixture.db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1`,[C])).rows;
  expect(lines.some(line=>/no verdict|arrange review/.test(line.text))).toBe(false);
  // Answering a System wake posts without waking anyone, and the tool result says so.
  await claim(handback[0]!);
  expect(await rootFixture.daemon.execute('reply',{id:handback[0]!.id,text:'Blocked: no reviewer verdict'},A)).toMatchObject({delivered:true,
    receipt:'Message stored and visible. No agents woken. A reply to a System wake is posted, not delivered to anyone; use message() to reach someone.'});
  await rootFixture.db.backgroundWork.drain();
});

it('Reproduction REVIEW-STUCK: a recorded review handback with no command (prod before the fix) is delivered once on the next machine evaluation', async () => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  await greenHead(109,'9'.repeat(40));
  const [review]=await commands(B,C);
  await claim(review!);
  await rootFixture.db.query(`SELECT beeline_finish_agent_command($1,'complete',NULL,NULL)`,[review!.id]);
  await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  // The old server recorded review-failed:<head>:<review> and queued nothing: recreate that state.
  const [first]=(await commands(A,C)).filter(command=>command.reason==='corner_review_needed');
  await rootFixture.db.query('DELETE FROM agent_commands WHERE id=$1',[first!.id]);
  const effects=async()=>(await rootFixture.db.query<{effects:string[]}>(
    `SELECT machine->'effects' effects FROM corner_facts WHERE corner_id=$1`,[C])).rows[0]!.effects;
  expect(await effects()).toContain(`review-failed:${'9'.repeat(40)}:${review!.id}`);
  expect((await commands(A,C)).filter(command=>command.reason==='corner_review_needed')).toHaveLength(0);
  // The next evaluation (a startup reconcile or any committed event) delivers it once, under the same id.
  for(let replay=0;replay<3;replay++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  const [handback,...extra]=(await commands(A,C)).filter(command=>command.reason==='corner_review_needed');
  expect(extra).toEqual([]);
  expect(handback!.id).toBe(first!.id);
  // Once it ran, the receipt is proven and replays never send it again.
  await claim(handback!);
  await result(handback!,'');
  await rootFixture.db.query(`SELECT beeline_finish_agent_command($1,'complete',NULL,NULL)`,[handback!.id]);
  for(let replay=0;replay<3;replay++) await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='corner_review_needed'`,[C])).rows)
    .toEqual([{id:first!.id}]);
  await rootFixture.db.backgroundWork.drain();
});

it.each(['empty', 'findings'])('a locked thread with a completed %s review and no implementer stops writing and queuing', async verdict => {
  const db = rootFixture.db;
  const head = 'a'.repeat(40);
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await greenHead(110, head);
  const [review] = await commands(B, C);
  await claim(review!);
  await db.query('UPDATE corner_facts SET locked=true,implementer_agent_id=NULL WHERE corner_id=$1', [C]);
  try {
    if (verdict === 'findings') await db.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
      VALUES('orphaned-review-findings',$1,$2,'FAIL: missing required evidence.',$3)`, [C, B, review!.turnRequestId]);
    await db.query(`SELECT beeline_finish_agent_command($1,'complete',NULL,NULL)`, [review!.id]);
    await db.query(`SELECT beeline_interrupt_agent_turn($1,$2,$3,NULL,NULL)`, [B,C,review!.turnRequestId]);
    await db.backgroundWork.drain();
    expect(await advanceCorner(db, C, { kind: 'reconcile' })).toMatchObject({ state: 'idle' });
    const before = (await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 ORDER BY id`, [C])).rows;
    await db.query(`CREATE TEMP TABLE review_noop_writes (corner_id uuid)`);
    await db.query(`CREATE FUNCTION pg_temp.record_review_noop_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO review_noop_writes VALUES (NEW.corner_id); RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER review_noop_write AFTER UPDATE OF machine ON corner_facts
      FOR EACH ROW EXECUTE FUNCTION pg_temp.record_review_noop_write()`);
    try {
      for (let replay = 0; replay < 3; replay++) {
        await advanceCorner(db, C, { kind: 'reconcile' });
        await advanceCorner(db, C, { kind: 'merge-refused', headSha: head, reason: 'base moved' });
      }
      expect((await db.query('SELECT * FROM review_noop_writes')).rows).toEqual([]);
      expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 ORDER BY id`, [C])).rows).toEqual(before);
      expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='corner_review_needed'`, [C])).rows).toEqual([]);
      expect((await db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [C])).rows).toEqual([{ archived_at: null }]);
    } finally {
      await db.query('DROP TRIGGER review_noop_write ON corner_facts');
      await db.query('DROP FUNCTION pg_temp.record_review_noop_write()');
      await db.query('DROP TABLE review_noop_writes');
    }
  } finally {
    await db.query('UPDATE corner_facts SET locked=false,implementer_agent_id=$2 WHERE corner_id=$1', [C, A]);
  }
});
