import { commanderReportAddress } from './commander.js';
import { cornerReviewWokenSql,noteReviewDispatchFailure } from './corner-lifecycle-review-state.js';
import { queueReviewerCommand } from './corner-lifecycle.js';
import { A,advanceCorner,assignCornerWorker,B,C,claim,commands,createAgentCommand,DaemonService,describe,expect,greenHead,H,it,LiveHub,PushDeliveryLoop,R,reconcileConfiguredCornerReviewers,result,REVIEWER_DISPATCH_REASONS,reviewerDispatchCarriesHead,rootFixture,routeSystemCommand,systemLine,vi } from './test-support-corner-review-dispatch.test-support.js';

describe('corner message attribution', () => {
  it('keeps automatic review errors out of a human commander’s conversation', async () => {
    const opened = await rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'human-work' }, H);
    expect(await commanderReportAddress(rootFixture.db, opened.id)).toMatchObject({ recipient: H, returnRoom: R });
    const before = (await rootFixture.db.query('SELECT id FROM messages')).rowCount;
    await noteReviewDispatchFailure(rootFixture.db, opened.id, 'a'.repeat(40), 'review queue unavailable');
    expect((await rootFixture.db.query('SELECT id FROM messages')).rowCount).toBe(before);
  });


  it('requests review after a new green event despite a historical verdict or brief change', async () => {
    const head = 'f'.repeat(40);
    /** A check verdict on `head`, as the GitHub webhook writes it. */
    const verdict = async (kind: 'check-passed' | 'rerun') => {
      if (kind === 'rerun') {
        await rootFixture.db.query(
          `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [C]);
        await advanceCorner(rootFixture.db, C, { kind: 'checks-pending' });
        await rootFixture.db.query(
          `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`, [C]);
      }
      await systemLine(rootFixture.db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' },
        verb: 'passed a check', kind: 'check-passed', object: { text: 'ci', headSha: head } });
    };
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,1,'Brief','Brief',$2,$3)`, [C, A, R]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
      JSON.stringify({ checks: 'passing', lifecycle: 'in-review', pr: { number: 30, headSha: head } })]);
    await verdict('check-passed');
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: the waiver is not in the brief.');
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const repairs=await commands(A,C);
    expect(repairs.some(item=>item.reason==='corner_review_needed')).toBe(true);
    for(const repair of repairs) { await claim(repair); await result(repair,'The waiver evidence is ready.'); }
    // A CI re-run on the same head and the same brief revision.
    await verdict('rerun');
    const repeated = (await commands(B, C)).length;
    console.info(`Reproduction REVIEW-DUP-1: new green review requests=${repeated}`);
    expect(repeated).toBe(1);
    const [pending] = await commands(B, C);
    expect(pending?.id).not.toBe(review!.id);
    // A revised brief cannot drop an older unanswered request.
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,2,'Brief','Brief with the waiver',$2,$3)`, [C, A, R]);
    await verdict('rerun');
    const afterBrief = (await rootFixture.db.query<{ reason: string }>(
      `SELECT reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2
         AND created_at>(SELECT created_at FROM corner_brief_revisions WHERE corner_id=$1 AND revision=2)`,
      [C, B],
    )).rows;
    console.info(
      `Reproduction review-redeliver: brief revision on verdicted head; wrong=1 repeat review wake; right=0; observed=${afterBrief.length}`,
    );
    expect((await commands(B,C)).some(item=>item.id===pending!.id)).toBe(true);
    await verdict('rerun');
    const [current]=await commands(B,C);
    expect(current?.reason).toBe('corner_review_dispatch');
    expect(current?.source.body).not.toMatch(/brief revision/i);
  });


  it('returns missing review configuration to the implementer', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(24, '8'.repeat(40));
    await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B]);
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=NULL WHERE id=$1`, [R]);
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(await commands(B, C)).toHaveLength(0);
    expect((await commands(A, C)).map(command => command.reason)).toContain('corner_review_needed');
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='corner-merge-yes'`, [C])).rowCount).toBe(0);
  });



  it('reports the failure privately and wakes the implementer when reviewer command insertion cannot queue', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(26, 'a'.repeat(40));
    await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B]);
    await rootFixture.db.query(`
      CREATE FUNCTION refuse_review_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.room_id='${C}' AND NEW.agent_id='${B}' THEN
          RAISE EXCEPTION 'review queue denied by trigger';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_review_command BEFORE INSERT ON agent_commands
        FOR EACH ROW EXECUTE FUNCTION refuse_review_command();
    `);
    try {
      await reconcileConfiguredCornerReviewers(rootFixture.db, R);
      expect(await commands(B, C)).toHaveLength(0);
      expect((await commands(A,R)).filter(command=>command.reason==='attention_report')
        .some(command => command.private && command.source.body.includes('reviewer command could not be queued'))).toBe(true);
      expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%review queue denied by trigger%'`, [C])).rowCount).toBe(0);
      const handback = (await commands(A, C)).filter(command => command.reason === 'corner_review_needed');
      expect(handback).toHaveLength(1);
      expect(handback[0]?.source.body).toContain('review queue denied by trigger');
    } finally {
      await rootFixture.db.query(`DROP TRIGGER IF EXISTS refuse_review_command ON agent_commands; DROP FUNCTION IF EXISTS refuse_review_command();`);
    }
  });


  it('hands a brief mismatch to the author, then reviews the repaired head', async () => {
    await rootFixture.db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'A1: preserve the agreed label',$2,$3)`,
      [C, A, R],
    );
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(19, '1'.repeat(40));
    const [firstReview] = await commands(B, C);
    await claim(firstReview!);
    await result(
      firstReview!,
      '@hoots F1: A1 is unmet; the agreed label is missing. Repair it and rerun affected checks.',
    );
    const [repair] = await commands(A, C);
    expect(repair).toBeDefined();
    await claim(repair!);
    await result(repair!, 'Fixed F1; the agreed label is present and the affected check passed.');
    expect(
      (await rootFixture.db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [C])).rowCount,
    ).toBe(0);

    await greenHead(19, '2'.repeat(40));
    const [secondReview] = await commands(B, C);
    expect(secondReview).toBeDefined();
    await claim(secondReview!);
    await expect(
      rootFixture.daemon.execute(
        'approveCornerMerge',
        {
          cornerId: C,
          headSha: '2'.repeat(40),
        },
        B,
      ),
    ).resolves.toMatchObject({ status: 'approved', headSha: '2'.repeat(40) });
    expect(
      (
        await rootFixture.db.query<{ head_sha: string }>(
          `SELECT head_sha FROM corner_merge_approvals WHERE corner_id=$1`,
          [C],
        )
      ).rows,
    ).toEqual([{ head_sha: '2'.repeat(40) }]);
  });


  it.each([false, true])('notifies an Attention requester about a non-repository deliverable at the recorded return address (tagged=%s)', async (tagged) => {
    await rootFixture.db.query(
      `UPDATE rooms SET repository_key=NULL,repository_resolution='none' WHERE id=$1`,
      [R],
    );
    await rootFixture.db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('human-device-token-123456789012345678903',$1,'android','physical')`,
      [H],
    );
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const push = new PushDeliveryLoop(rootFixture.db, { send });
      await push.runOnce();
      // An Attention request is a human message, not a system lifecycle fact.
      const sourceId = 'd'.repeat(63) + (tagged ? '1' : '0');
      await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please attach the report.')`,
        [sourceId, C, H]);
      await createAgentCommand(rootFixture.db, {
        roomId: C,
        agentId: A,
        sourceMessageId: sourceId,
        reason: 'human_tag',
      });
      const [worker] = await commands(A, C);
      await claim(worker!);
      // What post_artifact queues for the turn's final reply.
      await rootFixture.db.query(
        `INSERT INTO agent_pending_attachments(room_id,agent_id,url,name,mime_type,size,request_id)
         VALUES($1,$2,'https://example.test/media/report','report.pdf','application/pdf',10,$3)`,
        [C, A, worker!.turnRequestId],
      );
      const text = tagged ? '@human The report is attached.' : 'The report is attached.';
      await result(worker!, text);
      await push.runOnce();
      expect(send.mock.calls.map(([, message]) => message.text)).toEqual(
        [`Hoots: ${text}`],
      );
    } finally {
      await rootFixture.db.query(
        `UPDATE rooms SET repository_key='owner/widgets',repository_resolution='repository' WHERE id=$1`,
        [R],
      );
      await rootFixture.db.query(`DELETE FROM push_devices WHERE identity_id=$1`, [H]);
    }
  });


  // Reproduction REVIEW-HANDBACK-NULL: a corner an agent opened off its own
  // root message records no requester, so the cap stopped the handbacks and
  // said nothing — the transcript ended on the reviewer's last round.
  it('keeps a configured reviewer as the review target even when it is not a corner member', async () => {
    // Remove Goosy (B) from the CORNER (it stays a parent-Room member and the
    // configured reviewer). The check passes. Where does the review command go?
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      C,
      B,
    ]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 8, url: 'https://github.com/acme/repo/pull/8', headSha: '2'.repeat(40) },
        }),
      ],
    );
    await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await rootFixture.db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1 AND state IN ('pending','claimed')`,
        [C],
      )
    ).rows;
    console.log('routed:', JSON.stringify(routed));
    expect(routed).toHaveLength(1);
    expect(routed[0]!.agent_id).toBe(B);
  });


  it('treats a reviewer removed from the parent Room as no reviewer and wakes the implementer', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      R,
      B,
    ]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [
        C,
        JSON.stringify({
          checks: 'passing',
          lifecycle: 'in-review',
          pr: { number: 9, url: 'https://github.com/acme/repo/pull/9', headSha: '3'.repeat(40) },
        }),
      ],
    );
    await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
    const routed = (
      await rootFixture.db.query<{ agent_id: string; reason: string }>(
        `SELECT agent_id,reason FROM agent_commands WHERE room_id=$1 AND state IN ('pending','claimed')`,
        [C],
      )
    ).rows;
    // The commander's report about its own corner wakes it in that corner too.
    expect(routed.map(row => `${row.agent_id === A}:${row.reason}`).sort()).toEqual(['true:corner_review_needed']);
    expect((await commands(A, C)).find(command => command.reason === 'corner_review_needed')?.source.body).toContain('no reviewer is configured');
    expect(
      (
        await rootFixture.db.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`,
          [C],
        )
      ).rows.map((row) => row.text),
    ).toEqual([]);
    expect((await commands(A,R)).filter(command=>command.reason==='attention_report')
      .some(command=>command.private && command.source.body.includes('no reviewer is configured'))).toBe(true);
  });


  it('delivers to a parent-member reviewer without creating a corner roster row', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    expect((await rootFixture.db.query('SELECT 1 FROM memberships WHERE room_id=$1',[C])).rowCount).toBe(0);
    await greenHead(10,'4'.repeat(40));
    expect((await commands(B,C)).map(command => command.reason)).toEqual(['corner_review_dispatch']);
    expect((await rootFixture.db.query('SELECT 1 FROM memberships WHERE room_id=$1',[C])).rowCount).toBe(0);
  });


  it.each(['FAIL: required evidence is missing.', 'blocked: waiting for required checks.'])(
    'Reproduction REVIEW-STOP-1: %s leaves findings or a cause without retrying', async verdict => {
      await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
      const head = 'd'.repeat(40);
      await greenHead(95, head);
      const [review] = await commands(B, C);
      await claim(review!);
      await rootFixture.daemon.execute('report', { roomId: C, requestId: review!.turnRequestId, status: verdict.startsWith('blocked:') ? 'blocked' : 'failed', text: verdict.startsWith('blocked:') ? verdict : `failed: ${verdict}` }, B);
      await rootFixture.daemon.execute('postAgentTurnReceipt', { roomId: C, requestId: review!.turnRequestId, status: 'failed', reasonKind: 'hiccup', reason: 'unreported_order: runtime failed after delivery' }, B);
      const sourceId = (await rootFixture.db.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-passed' ORDER BY created_at DESC LIMIT 1`, [C])).rows[0]!.id;
      for (const reason of REVIEWER_DISPATCH_REASONS.filter(reason => !['agent_tag','order'].includes(reason))) {
        await createAgentCommand(rootFixture.db, { roomId: C, agentId: B, sourceMessageId: sourceId, reason });
      }
      await routeSystemCommand(rootFixture.db, { roomId: C, sourceMessageId: sourceId, kind: 'check-passed', targets: [B] });
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','\"pending\"') WHERE corner_id=$1`, [C]);
      await advanceCorner(rootFixture.db, C, { kind: 'checks-pending' });
      await greenHead(95, head);
      await reconcileConfiguredCornerReviewers(rootFixture.db, R);
      expect((await commands(B,C)).length).toBeGreaterThan(0);
      await greenHead(95, 'f'.repeat(40));
      expect((await commands(B, C)).length).toBeGreaterThan(0);
    });


  it('Reproduction review-redeliver: self-output stays inert; ordinary reports arrive and pending requests dedupe review', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    const head = 'e'.repeat(40);
    // The reviewer already ordered a repair. Their next report walks up to that
    // order and would otherwise be handed back to them as a new review.
    await createAgentCommand(rootFixture.db, {
      roomId: C, agentId: A, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: B, fromRoomId: C, text: 'Repair the previous head' },
    });
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1 AND reason='order'`, [C]);
    await greenHead(91, head);
    const [review] = await commands(B, C);
    expect(review?.reason).toBe('corner_review_dispatch');
    await claim(review!);
    const beforeEcho = (await rootFixture.db.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B],
    )).rows.map(row => row.id);
    const echoed = await rootFixture.daemon.execute('report', { roomId: C, requestId: review!.turnRequestId, status: 'failed', text: 'failed: FAIL: the pull request is unchanged.' }, B);
    const afterEcho = (await rootFixture.db.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, B],
    )).rows.map(row => row.id);
    expect(echoed).toMatchObject({ delivered: true });
    expect((await commands(A, C)).find(command => command.id === echoed.id))
      .toMatchObject({ private: true, source: { authorId: B, body: expect.stringContaining('failed: FAIL: the pull request is unchanged.') } });
    expect(afterEcho).toEqual(beforeEcho);
    await result(review!, 'FAIL: the pull request is unchanged.');
    const verdicted = new Set(afterEcho);
    const sourceId = (await rootFixture.db.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND system_event->>'kind'='check-passed'
       ORDER BY created_at DESC LIMIT 1`, [C],
    )).rows[0]!.id;
    const parent = (await rootFixture.db.query(`SELECT * FROM agent_commands WHERE id=$1`, [review!.id])).rows[0];
    // A brief revision still requires every new delivery to target that revision.
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,1,'Revised brief','Revised brief',$2,$3)`, [C, A, R]);
    await advanceCorner(rootFixture.db, C, { kind: 'brief-revised', revision: 1, sourceMessageId: sourceId, command: parent });
    const delivered: string[] = [];
    // Every path that asks for a review of this head. A chat tag or order is
    // not one of them: the reviewer still has to receive ordinary work.
    const reviewPaths = REVIEWER_DISPATCH_REASONS.filter(reason => reason !== 'agent_tag' && reason !== 'order');
    for (const reason of reviewPaths) {
      const created = await createAgentCommand(rootFixture.db, {
        roomId: C,
        agentId: B,
        sourceMessageId: reason === 'subscribed_event' || reason === 'corner_review_dispatch' ? sourceId : null,
        reason,
        ...(reason === 'report' ? { parent, reportSource: parent } : {}),
        ...(reason === 'report' ? {
          privatePayload: {
            kind: reason, authorId: A, fromRoomId: C,
            text: 'failed: FAIL: same head again.',
          },
        } : {}),
      });
      if (created && !verdicted.has(created.id)) delivered.push(`${reason}:${created.id}`);
    }
    // Explicit re-review requests remain deliverable after an evidence-only repair.
    const repairTurn = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'agent_tag', parent });
    expect(repairTurn?.review_context).toMatchObject({ purpose: 'repair', headSha: head });
    const repairRow = (await rootFixture.db.query(`SELECT * FROM agent_commands WHERE id=$1`, [repairTurn!.id])).rows[0];
    for (const reason of ['agent_tag', 'order'] as const) {
      const created = await createAgentCommand(rootFixture.db, {
        roomId: C, agentId: B, sourceMessageId: null, reason, parent: repairRow,
        ...(reason === 'order' ? {
          privatePayload: { kind: reason, authorId: A, fromRoomId: C, text: 'Please review the same head again' },
        } : {}),
      });
      expect(created?.reason).toBe(reason);
      verdicted.add(created!.id);
    }
    expect(reviewerDispatchCarriesHead('agent_tag', undefined, { headSha: head })).toBe(false);
    for (const reason of ['agent_tag', 'order'] as const) {
      const created = await createAgentCommand(rootFixture.db, {
        roomId: C, agentId: B, sourceMessageId: null, reason,
        ...(reason === 'order' ? {
          privatePayload: { kind: reason, authorId: A, fromRoomId: C, text: 'Release the hold on this head' },
        } : {}),
      });
      expect(created?.reason).toBe(reason);
      verdicted.add(created!.id);
    }
    expect(reviewerDispatchCarriesHead('agent_tag', undefined, { headSha: head, pullRequest: 91 })).toBe(false);
    expect(reviewerDispatchCarriesHead('report', undefined, { purpose: 'verdict', headSha: head })).toBe(true);
    await routeSystemCommand(rootFixture.db, { roomId: C, sourceMessageId: sourceId, kind: 'check-passed', targets: [B] });
    await advanceCorner(rootFixture.db, C, { kind: 'checks', result: 'passing', sourceMessageId: sourceId });
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    const afterPaths = (await rootFixture.db.query<{ id: string; reason: string }>(
      `SELECT id,reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND NOT (id=ANY($3::text[]))`,
      [C, B, [...verdicted]],
    )).rows;
    console.info(
      `Reproduction review-redeliver: head ${head}; ordinary reports=${delivered.length}; new deliveries=${afterPaths.length}`,
    );
    expect(delivered).toEqual(expect.arrayContaining([expect.stringMatching(/^report:/)]));
    expect(delivered).toHaveLength(reviewPaths.length);
    expect(afterPaths.map(command=>command.reason).sort()).toEqual([...reviewPaths].sort());
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1 AND agent_id=$2`,[C,A]);
    await rootFixture.db.query(`UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND agent_id=$2`,[C,A]);
    await greenHead(91,head);
    const pending=await commands(B,C);
    expect(pending.filter(command=>command.reason==='corner_review_dispatch')).toHaveLength(1);
    expect(pending.filter(command=>command.reason==='order')).toHaveLength(2);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND state='pending' AND reason IN ('order','agent_tag') AND review_context->>'purpose' IS NULL
      AND review_context->'checks'->>'status'='passing'`,[C,B])).rowCount).toBeGreaterThan(0);
  });


  it('Reproduction review-redeliver: a new head and a repair handback still wake the reviewer', async () => {
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(92, 'f'.repeat(40));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!, 'FAIL: show the repaired screen.');
    // A brief revision on the judged head must not swallow the next head.
    await rootFixture.db.query(`INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id)
      VALUES($1,1,'Brief','Brief changed, code unchanged',$2,$3)`, [C, A, R]);
    await greenHead(92, '1'.repeat(40));
    const [nextHead] = await commands(B, C);
    expect(nextHead?.reason).toBe('corner_review_dispatch');
    expect((await rootFixture.db.query(`SELECT review_context->>'headSha' head FROM agent_commands WHERE id=$1`, [nextHead!.id])).rows[0]).toEqual({ head: '1'.repeat(40) });
    // A repair handback is an order whose purpose is repair. It is not a repeat review.
    expect(reviewerDispatchCarriesHead('order', undefined, { purpose: 'repair', headSha: '1'.repeat(40) })).toBe(false);
    await rootFixture.db.query(`UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true') WHERE room_id=$1 AND card->>'reportToId' IS NOT NULL`, [C]);
    const parent = (await rootFixture.db.query(`SELECT * FROM agent_commands WHERE id=$1`, [nextHead!.id])).rows[0];
    const handback = await createAgentCommand(rootFixture.db, {
      roomId: C, agentId: B, sourceMessageId: null, reason: 'order', parent,
      privatePayload: { kind: 'order', authorId: A, fromRoomId: C, text: 'The repair is ready for review' },
    });
    expect(handback?.reason).toBe('order');
    expect(handback?.review_context).toMatchObject({ purpose: 'repair' });
    console.info('Reproduction review-redeliver: new head review dispatch and repair handback both woke the reviewer');
  });
});
describe('the corner implementer the workflow wakes follows a person hand-over', () => {

  it('a zero-check PR is completed for the current implementer, not the opener', async () => {
    const checkGate = vi.fn(async () => ({
      checks: 'pending' as const,
      checkCount: 0,
      zeroChecksConfirmed: true,
      pullRequest: 'https://github.com/acme/repo/pull/7',
      headSha: '1'.repeat(40),
      approvalPending: true,
      reviewer: '@hoots',
      reviewerExists: true,
      reviewerWake: { status: 'waiting' as const, detail: 'No checks have reported.' },
      rule: 'Only the configured reviewer records PASS.',
    }));
    rootFixture.daemon = new DaemonService(
      rootFixture.db,
      new LiveHub(),
      undefined,
      undefined,
      false,
      undefined,
      false,
      undefined,
      checkGate,
    );
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
    await assignCornerWorker(rootFixture.db, C, B);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$3::jsonb WHERE corner_id=$1 AND $2::text IS NOT NULL`, [
      C,
      B,
      JSON.stringify({
        checks: 'unknown',
        lifecycle: 'in-review',
        pr: {
          number: 7,
          url: 'https://github.com/acme/repo/pull/7',
          headSha: '1'.repeat(40),
          mergeability: 'clean',
        },
      }),
    ]);
    const source = await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'requested work',
    });
    await createAgentCommand(rootFixture.db, {
      roomId: C,
      agentId: B,
      sourceMessageId: source.id,
      reason: 'human_tag',
    });
    const [worker] = await commands(B, C);
    await claim(worker!);
    await result(worker!, 'https://github.com/acme/repo/pull/7');
    await vi.waitFor(()=>expect(checkGate).toHaveBeenCalledOnce());
    expect(
      (
        await rootFixture.db.query<{ lifecycle: { checks: string } }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [C],
        )
      ).rows[0]?.lifecycle.checks,
    ).toBe('passing');
  });
});


it.each(['empty','status','failed'])('a %s review result ends silently without retrying',async ending=>{
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  await greenHead(91,'d'.repeat(40));
  const [review]=await commands(B,C);await claim(review!);
  if(ending==='status')await result(review!,'Review ended without a verdict.');
  else await rootFixture.daemon.execute('postAgentTurnReceipt',{ roomId:C, requestId:review!.turnRequestId, status:ending==='failed'?'failed':'complete', ...(ending==='failed'?{reason:'provider unavailable'}:{}) },B);
  for(let event=0;event<3;event++)await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  expect((await commands(B,C)).some(item=>item.id===review!.id)).toBe(ending!=='status');
  expect((await rootFixture.db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1`,[C])).rows
    .some(line=>line.text.includes('reviewer gave no verdict'))).toBe(false);
  if(ending==='failed')expect((await commands(A,C)).filter(c=>c.reason==='report'&&c.source.body.includes('failed:'))).toHaveLength(0);

});


it('Reproduction REVIEW-LOOP: a current member tag reaches a reviewer after an empty completion', async () => {
  await rootFixture.phone.execute('updateRoom', {roomId:R,reviewerAgentId:B},H);
  await greenHead(92,'e'.repeat(40));
  const [review]=await commands(B,C);
  await claim(review!);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{ roomId:C, requestId:review!.turnRequestId, status:'complete' },B);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('retry-tag',$1,$2,'@goosy please review this head')`,[C,A]);
  const {routeAgentResult}=await import('./test-fixtures/queue-routing.test-support.js');
  const parent=(await rootFixture.db.query(`SELECT * FROM agent_commands WHERE id=$1`,[review!.id])).rows[0];
  const routed=await routeAgentResult(rootFixture.db,{...parent,agent_id:A,review_context:{...parent.review_context,purpose:'repair'}},'retry-tag',{roomId:C,agentId:A});
  expect(routed).toEqual({woken:['goosy'],notWoken:[]});
});


it.each(['PASS: screenshots are attached here.', 'PASS: no blockers; screenshots attached here.',
  'PASS: no blockers and screenshots attached here.', 'PASS: no blockers screenshots attached here.',
  'PASS: please merge screenshots attached here.', 'PASS: screenshots attached here, no blockers.',
  'PASS: screenshots attached here; please merge.', 'PASS: screenshots attached here; the PR has no blockers.'])(
  'Reproduction REVIEW-LOOP: absent attachments refuse the claim: %s', async text => {
  await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
  const head='f'.repeat(40);
  await greenHead(93,head);
  const [review]=await commands(B,C);
  await claim(review!);
  await result(review!,text);
  await expect(rootFixture.daemon.execute('approveCornerMerge',{cornerId:C,headSha:head},B)).rejects.toThrow(/missing.*attachment/i);
  // Guard an approval that was recorded before the claiming report arrived.
  await rootFixture.db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
    VALUES($1,$2,93,$3)`,[C,B,head]);
  const {cornerMergeGate}=await import('./corner-lifecycle.js');
  const gate=await cornerMergeGate(rootFixture.db,C,{number:93,headSha:head});
  expect(gate.open).toBe(false);
  expect(gate).toMatchObject({evidenceMissing:true});
});


it.each(['Screenshots in the PR show the result.', 'No screenshots are attached.',
  'Please attach screenshots before merging.', 'Screenshots should be attached.',
  'The PR has screenshots attached.', 'Screenshots are not attached.', 'Screenshots are missing; please attach files.',
  'No screenshots attached, but the checks pass.', 'The attached screenshots in the PR show the result.'])(
  'Reproduction REVIEW-LOOP: discussing evidence is not a delivery claim: %s', async text => {
    await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
    const head='1'.repeat(40);
    await greenHead(94,head);
    const [review]=await commands(B,C);
    await claim(review!);
    await result(review!,`PASS: reviewed. ${text}`);
    await expect(rootFixture.daemon.execute('approveCornerMerge',{cornerId:C,headSha:head},B)).resolves.toMatchObject({status:'approved'});
  });


it.each(['final','report'])(
  'Reproduction REVIEW-LOOP: %s attachment claims require files on that review', async delivery => {
    await rootFixture.phone.execute('updateRoom',{roomId:R,reviewerAgentId:B},H);
    const head='2'.repeat(40);
    await greenHead(95,head);
    const [review]=await commands(B,C);
    await claim(review!);
    if(delivery==='report') {
      await rootFixture.daemon.execute('report',{ roomId:C, requestId:review!.turnRequestId, status:'done', text:'done: PASS. Screenshots are attached here.' },B);
    } else await result(review!,'PASS: screenshots attached.');
    await expect(rootFixture.daemon.execute('approveCornerMerge',{cornerId:C,headSha:head},B)).rejects.toThrow(/missing.*attachment/i);
    // A file on an unrelated older message must not satisfy this verdict.
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES
      ('unrelated-file',$1,$2,'Earlier file','[{"name":"older.png","url":"https://example.test/old.png"}]')`,[C,B]);
    await expect(rootFixture.daemon.execute('approveCornerMerge',{cornerId:C,headSha:head},B)).rejects.toThrow(/missing.*attachment/i);
    if(delivery==='final') {
      await rootFixture.db.query(`UPDATE messages SET attachments='[{"name":"proof.png","url":"https://example.test/proof.png"}]'
        WHERE request_id=$1`,[review!.turnRequestId]);
    } else {
      const reportId=(await rootFixture.db.query<{id:string}>('SELECT result_message_id id FROM agent_commands WHERE id=$1',[review!.id])).rows[0]!.id;
      await rootFixture.db.query(`UPDATE messages SET attachments='[{"name":"proof.png","url":"https://example.test/proof.png"}]' WHERE id=$1`,[reportId]);
      await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{attachments}',
        '[{"name":"proof.png","url":"https://example.test/proof.png"}]') WHERE id=$1`,[reportId]);
    }
    await expect(rootFixture.daemon.execute('approveCornerMerge',{cornerId:C,headSha:head},B)).resolves.toMatchObject({status:'approved'});
  });


it.each(['complete','failed'] as const)('Reproduction review-1: a delivered repair order is a verdict even without a final reply or report (%s)', async status => {
  await rootFixture.phone.execute('updateRoom', {roomId:R,reviewerAgentId:B}, H);
  const head='c5e43cc29583eea666a240fad67c3c2f33fde945';
  await greenHead(3060,head);
  const [review]=await commands(B,C);
  await claim(review!);
  await rootFixture.daemon.execute('order',{ roomId:C, requestId:review!.turnRequestId, address:C, agent:'@hoots', text:'FAIL: the sample endpoint accepts an invalid request. Add the required validation.' },B);
  await rootFixture.daemon.execute('postAgentTurnReceipt',{ roomId:C, requestId:review!.turnRequestId, status, ...(status==='complete'?{completionKind:'no-reply' as const}:{reason:'unreported_order: runtime failed after delivery',reasonKind:'hiccup' as const}) },B);
  const repairs=(await commands(A,C)).filter(c=>c.reason==='order');
  expect(repairs.length).toBeGreaterThan(0);
  await rootFixture.db.query("UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1 AND agent_id=$2",[C,A]);
  await reconcileConfiguredCornerReviewers(rootFixture.db,R);
  expect((await commands(B,C)).some(item=>item.id===review!.id)).toBe(true);
});


it.each(['pending', 'claimed'] as const)(
  'REVIEW-CHECK-WAKE: a %s check notice cannot stand in for a review request',
  async (state) => {
    const head = '6'.repeat(40);
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, B]);
    await rootFixture.db.query(
      `UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1`,
      [C],
    );
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({ checks: 'pending', pr: { number: 96, headSha: head } })],
    );
    const source = `check-notice-${state}`;
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,presentation,text,system_event)
      VALUES($1,$2,$3,'system','A check passed',$4::jsonb)`,
      [source, C, H, JSON.stringify({ kind: 'check-passed', object: { headSha: head } })],
    );
    const notice = await createAgentCommand(rootFixture.db, {
      roomId: C,
      agentId: B,
      sourceMessageId: source,
      reason: 'subscribed_event',
    });
    expect(notice).toBeDefined();
    if (state === 'claimed') await claim((await commands(B, C))[0]!);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`,
      [C],
    );
    await advanceCorner(rootFixture.db, C, {
      kind: 'checks',
      result: 'passing',
      sourceMessageId: source,
    });
    const reviews = (
      await rootFixture.db.query<{ id: string; turn_request_id: string; review_context: unknown }>(
        `SELECT id,turn_request_id,review_context FROM agent_commands
       WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_dispatch'`,
        [C, B],
      )
    ).rows;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.review_context).toMatchObject({
      headSha: head,
      pullRequest: 96,
      checks: expect.any(Object),
    });
    expect(reviews[0]?.turn_request_id).not.toBe(notice!.turn_request_id);
    if (state === 'pending') {
      const worker = await createAgentCommand(rootFixture.db, {
        roomId: C,
        agentId: A,
        sourceMessageId: null,
        reason: 'human_tag',
      });
      await claim((await commands(A, C)).find((command) => command.id === worker!.id)!);
      expect((await commands(B, C)).some((command) => command.id === reviews[0]!.id)).toBe(true);
      await rootFixture.daemon.execute(
        'postAgentTurnReceipt',
        { roomId: C, requestId: worker!.turn_request_id, status: 'complete' },
        A,
      );
      expect((await commands(B, C)).some((command) => command.id === reviews[0]!.id)).toBe(true);
    }
    expect(
      (await rootFixture.db.query(`SELECT ${cornerReviewWokenSql('$1')} woken`, [C])).rows[0]
        ?.woken,
    ).toBe(true);
    await advanceCorner(rootFixture.db, C, {
      kind: 'checks',
      result: 'passing',
      sourceMessageId: source,
    });
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(
      (
        await rootFixture.db.query(
          `SELECT id FROM agent_commands WHERE room_id=$1
      AND agent_id=$2 AND reason='corner_review_dispatch'`,
          [C, B],
        )
      ).rows,
    ).toHaveLength(1);
  },
);

it.each(
  ['corner_review_dispatch', 'order', 'agent_tag'].flatMap((reason) =>
    (['pending', 'claimed', 'complete'] as const).map((state) => ({ reason, state })),
  ),
)(
  'REVIEW-PENDING-AC6: $state $reason before green cannot suppress the first green-head review',
  async ({ reason, state }) => {
    const head = '8'.repeat(40);
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, B]);
    await rootFixture.db.query(
      `UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1`,
      [C],
    );
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({ checks: 'pending', pr: { number: 98, headSha: head } })],
    );
    const source = `pending-review-${reason}-${state}`;
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,presentation,text,system_event)
      VALUES($1,$2,$3,'system','A check passed',$4::jsonb)`,
      [source, C, H, JSON.stringify({ kind: 'check-passed', object: { headSha: head } })],
    );
    const earlier = await rootFixture.db.transaction((tx) =>
      queueReviewerCommand(tx, {
        roomId: C,
        agentId: B,
        sourceMessageId: source,
        reason,
      }),
    );
    expect(earlier.command?.review_context).toMatchObject({
      headSha: head,
      checks: { status: 'pending' },
    });
    const wokenBeforeGreen = (
      await rootFixture.db.query(`SELECT ${cornerReviewWokenSql('$1')} woken`, [C])
    ).rows[0]?.woken;
    if (state !== 'pending') {
      await claim((await commands(B, C)).find((command) => command.id === earlier.command!.id)!);
      if (state === 'complete')
        await rootFixture.daemon.execute(
          'postAgentTurnReceipt',
          { roomId: C, requestId: earlier.command!.turn_request_id, status: 'complete' },
          B,
        );
    }
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"passing"') WHERE corner_id=$1`,
      [C],
    );
    await advanceCorner(rootFixture.db, C, {
      kind: 'checks',
      result: 'passing',
      sourceMessageId: source,
    });
    const greenRequests = async () =>
      (
        await rootFixture.db.query(
          `SELECT id,review_context FROM agent_commands WHERE room_id=$1 AND agent_id=$2
       AND reason='corner_review_dispatch' AND review_context->'checks'->>'status'='passing'`,
          [C, B],
        )
      ).rows;
    expect(await greenRequests()).toEqual([
      expect.objectContaining({
        id: expect.not.stringMatching(`^${earlier.command!.id}$`),
        review_context: expect.objectContaining({
          headSha: head,
          pullRequest: 98,
          checks: expect.objectContaining({ status: 'passing' }),
        }),
      }),
    ]);
    expect(
      (
        await rootFixture.db.query('SELECT state,review_context FROM agent_commands WHERE id=$1', [
          earlier.command!.id,
        ])
      ).rows[0],
    ).toMatchObject({ state:'pending', review_context: { checks: { status: 'pending' } } });
    expect(wokenBeforeGreen).toBe(false);
    expect(
      (await rootFixture.db.query(`SELECT ${cornerReviewWokenSql('$1')} woken`, [C])).rows[0]
        ?.woken,
    ).toBe(true);
    await reconcileConfiguredCornerReviewers(rootFixture.db, R);
    expect(await greenRequests()).toHaveLength(1);
  },
);

it.each(['pending', 'claimed', 'complete'] as const)(
  'REVIEW-CHECK-WOKEN: a %s check notice with head context never proves review delivery',
  async (state) => {
    const head = '7'.repeat(40);
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, B]);
    await rootFixture.db.query(
      `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({ checks: 'pending', pr: { number: 97, headSha: head } })],
    );
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,presentation,text,system_event)
    VALUES('check-only',$1,$2,'system','A check passed',$3::jsonb)`,
      [C, H, JSON.stringify({ kind: 'check-passed', object: { headSha: head } })],
    );
    await rootFixture.db.query(
      `INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
    root_command_id,root_source_message_id,source_message_id,agent_depth,review_context,state) VALUES
    ('check-only',$1,$2,'check-only','input','subscribed_event','check-only','check-only','check-only',0,$3::jsonb,$4)`,
      [C, B, JSON.stringify({ headSha: head, pullRequest: 97, briefRevision: 0 }), state],
    );
    expect(
      (await rootFixture.db.query(`SELECT ${cornerReviewWokenSql('$1')} woken`, [C])).rows[0]
        ?.woken,
    ).toBe(false);
  },
);

it('committed-event recovery: startup green, lost command and reviewer completion share one timer-free runtime', async () => {
  const { CornerMachineEvents } = await import('./corner-attention.js');
  const { POSTGRES_LIVE_CHANNEL } = await import('./postgres-live.js');
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  const headSha = '6'.repeat(40);
  // Startup has no GitHub client and no repair interval.
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 98, headSha, url: 'https://github.com/acme/repo/pull/98' } })]);
  const live = new LiveHub();
  const errors: unknown[] = [];
  const machine = new CornerMachineEvents(rootFixture.db, live, error => errors.push(error));
  const release = await rootFixture.db.client.listen(POSTGRES_LIVE_CHANNEL, payload => {
    const event = JSON.parse(payload);
    if (event.table === 'corner_state') live.publish({ type: 'invalidate', roomId: event.roomId, reason: 'postgres:corner_state' });
  });
  try {
    live.resync();
    await vi.waitFor(async () => expect(await commands(B, C)).toHaveLength(1));
    const [lost] = await commands(B, C);
    expect(lost).toBeDefined();
    expect((await commands(B,R)).every(item=>item.roomId===R)).toBe(true);
    await rootFixture.db.query('DELETE FROM agent_commands WHERE id=$1', [lost!.id]);
    await vi.waitFor(async () => expect(await commands(B, C)).toHaveLength(1));
    const [review] = await commands(B, C);
    await claim(review!);
    await result(review!,'The review is complete.');
    for (let replay = 0; replay < 3; replay++) live.publish({ type: 'invalidate', roomId: C, reason: 'postgres:corner_state' });
    await machine.refresh(C);
    const lines=(await rootFixture.db.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1`,[C])).rows;
    expect(lines.some(line=>line.text.includes('reviewer gave no verdict'))).toBe(false);
    expect((await commands(A, C)).filter(command => command.reason === 'corner_review_needed')).toHaveLength(0);
    expect(await commands(B, C)).toEqual([]);
    expect(errors).toEqual([]);
    await machine.stop();
    // A preceding image closed the Room while this listener was down.
    await rootFixture.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [C]);
    const recovery = new CornerMachineEvents(rootFixture.db, live, error => errors.push(error));
    try {
      await recovery.start();
      expect((await rootFixture.db.query(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`, [C])).rows).toEqual([{state:'archived'}]);
    } finally { await recovery.stop(); }
  } finally {
    await machine.stop();
    await release();
  }
});


it('event recovery drains its startup scan before shutdown', async () => {
  const { CornerMachineEvents } = await import('./corner-attention.js');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scan = new Promise<void>(resolve => { entered = resolve; });
  const query = rootFixture.db.query.bind(rootFixture.db), errors: unknown[] = [];
  const runtime = new CornerMachineEvents({
    query: async (sql, values) => {
      if (sql.includes('LEFT JOIN corner_facts fact ON fact.corner_id=corner.id')) { entered(); await gate; }
      return query(sql, values);
    }, transaction: work => rootFixture.db.transaction(work),
  }, new LiveHub(), error => errors.push(error));
  const recovery = runtime.start(); await scan;
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release(); await Promise.all([recovery, stopping]);
  expect(errors).toEqual([]);
});
