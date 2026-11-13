import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { expect, it, createAgentCommand, nextAgentDepth, reconcileCornerMergeBlockers, reconcileConfiguredCornerReviewers, routeSystemCommand, readAgentCommands, systemLine, advanceCorner, H, A, B, R, C, id, db, phone, daemon, commands, send, helperOwner, claim, result, landCorner, rootFixture } from './test-support-agent-command.integration.test-support.js';


it('gives old helpers only projected commands and refuses unsolicited old output', async () => {
  await send('@hoots');
  await send('ordinary traffic');
  const a = await rootFixture.daemon.execute('getRoomInbox', { roomId: R }, A);
  const b = await rootFixture.daemon.execute('getRoomInbox', { roomId: R }, B);
  expect(a.items).toHaveLength(1);
  // The item reached A because the server routed it to A; the row itself
  // carries no reader to re-check that against.
  expect(a.items[0]?.authorId).toBe(H);
  expect(b.items).toEqual([]);
  await expect(
    rootFixture.daemon.execute(
      'postRoomMessage',
      { roomId: R, text: 'Unsolicited', requestId: a.items[0]!.id },
      B,
    ),
  ).rejects.toThrow();
});

it('wakes the opener for failed checks even after a reviewer turn and retries a lost command', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  const reviewerSource = await send('Review this', C);
  await rootFixture.db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: C,
      sourceMessageId: reviewerSource.messageId,
      targets: [A],
      kind: 'joined',
    }),
  );
  const [review] = await commands(A, C);
  await claim(review!);
  await result(review!, 'Review complete');
  await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  const headSha = 'e'.repeat(40);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'failing',
        pr: {
          number: 31,
          headSha,
          title: 'Fix checks',
          url: 'https://github.com/acme/repo/pull/31',
        },
      }),
    ],
  );
  const note = await systemLine(rootFixture.db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'failed a check',
    kind: 'check-failed',
    object: { text: 'typecheck', headSha },
  });
  expect(await commands(B, C)).toEqual([
    expect.objectContaining({ reason: 'corner_check', sourceMessageId: note.id }),
  ]);
  expect((await readAgentCommands(rootFixture.db, A, C)).commands).toHaveLength(0);
  // A deleted wake is recovered from the recorded checks despite its effect receipt.
  await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(0);
});


it('recovers a dirty PR lifecycle once per head and retries an undelivered conflict', async () => {
  const headSha = 'f'.repeat(40);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      checks: 'passing',
      pr: {
        number: 32,
        headSha,
        title: 'Resolve conflict',
        url: 'https://github.com/acme/repo/pull/32',
        mergeability: 'dirty',
      },
    }),
  ]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  expect(await commands(B, C)).toEqual([
    expect.objectContaining({ reason: 'corner_merge_conflict' }),
  ]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(0);
  await rootFixture.db.query(`DELETE FROM agent_commands WHERE room_id=$1`, [C]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,baseSha}',to_jsonb($2::text))
     WHERE corner_id=$1`,
    [C, 'a'.repeat(40)],
  );
  // A moved base is not a new head: the conflict wake stays one per head.
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(0);
  expect(await commands(B, C)).toHaveLength(1);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(0);
});


it('keeps every accepted merge-conflict wake after its head moves', async () => {
  const headA = '1'.repeat(40), headB = '2'.repeat(40);
  const dirty = (headSha: string) =>
    JSON.stringify({
      checks: 'passing',
      pr: {
        number: 41,
        headSha,
        title: 'Resolve conflict',
        url: 'https://github.com/acme/repo/pull/41',
        mergeability: 'dirty',
      },
    });
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, dirty(headA)]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  const [staleWake] = await commands(B, C);
  expect(staleWake?.reason).toBe('corner_merge_conflict');
  expect(staleWake?.source.body).toContain(headA);
  // The PR head moves before the implementer claims the queued wake.
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, dirty(headB)]);
  const delivered = (await commands(B, C)).filter((command) => command.reason === 'corner_merge_conflict');
  const staleState = (
    await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [staleWake!.id])
  ).rows[0]?.state;
  expect(delivered.map(command=>command.id)).toContain(staleWake!.id);
  expect(staleState).toBe('pending');
  await claim(staleWake!);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  const current=(await commands(B,C)).filter(command=>command.reason==='corner_merge_conflict');
  expect(current).toHaveLength(2);
  expect(current.some(command=>command.source.body.includes(headB))).toBe(true);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(0);
});


it.each(['delivery', 'claim'])('keeps an accepted failed-check wake after the head changes at %s', async boundary => {
  const oldHead = '1'.repeat(40), newHead = '2'.repeat(40);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({ checks: 'failing', pr: { number: 41, headSha: oldHead } })]);
  const line = await systemLine(rootFixture.db, { roomId: C, authorId: H,
    subject: { kind: 'github', name: 'GitHub' }, verb: 'found failing checks on',
    object: { text: 'pull request #41', headSha: oldHead } });
  const queued = await createAgentCommand(rootFixture.db, { roomId: C, agentId: B, sourceMessageId: line.id, reason: 'corner_check' });
  expect(queued).toBeTruthy();
  const [stale] = await commands(B, C);
  expect(stale?.reason).toBe('corner_check');
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({ checks: 'passing', pr: { number: 41, headSha: newHead } })]);
  if (boundary === 'delivery') expect(await commands(B,C)).toHaveLength(1);
  await claim(stale!);
  expect(await commands(B,C)).toHaveLength(1);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[queued!.id])).rows[0]?.state).toBe('pending');
});


it('keeps a failed-check wake retryable while its opener is unreachable', async () => {
  const headSha = '9'.repeat(40);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'failing',
        pr: {
          number: 33,
          headSha,
          title: 'Repair CI',
          url: 'https://github.com/acme/repo/pull/33',
        },
      }),
    ],
  );
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await systemLine(rootFixture.db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'failed a check',
    kind: 'check-failed',
    object: { text: 'typecheck', headSha },
  });
  await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await expect(reconcileCornerMergeBlockers(rootFixture.db)).resolves.toBe(1);
  expect(await commands(B, C)).toHaveLength(1);
});


it('routes subscribed events, grants and changed corner checks through actions', async () => {
  await rootFixture.daemon.execute('setEventSubscriptions', { roomId: R, kinds: ['joined'] }, A);
  await systemLine(rootFixture.db, {
    roomId: R,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'joined',
    kind: 'joined',
  });
  expect((await commands())[0]?.reason).toBe('subscribed_event');
  const [c] = await commands();
  await claim(c!);
  const source = await send('Grant decision');
  await rootFixture.db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: R,
      sourceMessageId: source.messageId,
      targets: [A],
      kind: 'grant-decided',
      commandId: c!.id,
    }),
  );
  const resume=(await commands()).find(command=>command.reason==='resume');
  expect(resume?.action).toBe('input');
  expect(resume?.parentCommandId).toBe(c!.id);
  expect(resume?.turnRequestId).not.toBe(c!.turnRequestId);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"passing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await expect(
    rootFixture.daemon.execute('getAgentConfiguration', { agentId: A, roomId: C }, A),
  ).resolves.toEqual(expect.objectContaining({ reviewerHandle: 'hoots' }));
  await rootFixture.db.query(`DELETE FROM agent_subscriptions WHERE source='room' AND agent_id=$1`, [
    A,
  ]);
  for (let n = 0; n < 2; n++)
    await systemLine(rootFixture.db, {
      roomId: C,
      subject: { kind: 'person', id: H, name: 'Human' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
  expect(await commands(B, C)).toHaveLength(0);
  expect(await commands(A, C)).toHaveLength(1);
  expect((await commands(A, C))[0]?.reason).toBe('corner_review_dispatch');

  await rootFixture.db.query(`DELETE FROM agent_commands`);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    A,
  ]);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"failing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(rootFixture.db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'failed a check',
    kind: 'check-failed',
  });
  expect((await readAgentCommands(rootFixture.db, A, C)).commands).toHaveLength(0);
  expect(await commands(B, C)).toHaveLength(1);

  await rootFixture.db.query(`DELETE FROM agent_commands`);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"passing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
  await systemLine(rootFixture.db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  // No reviewer: the implementer owns arranging review or asking for a decision.
  expect((await commands(B, C)).map(command => command.reason).sort()).toEqual(['corner_review_needed', 'report']);
});

it('holds the green review wake while the corner worker still holds a live turn', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  // B is the corner's worker and is mid-turn: it claimed a command and its
  // lease is live.
  const worker = await send('Do the work', C);
  await rootFixture.db.transaction((tx) =>
    routeSystemCommand(tx, {
      roomId: C,
      sourceMessageId: worker.messageId,
      targets: [B],
      kind: 'joined',
    }),
  );
  const [workerCommand] = await commands(B, C);
  expect(workerCommand).toBeDefined();
  await claim(workerCommand!, 'gw');

  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"passing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(rootFixture.db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });

  // The machine waits for the worker's terminal receipt before assigning review.
  await expect(
    rootFixture.db
      .query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2`, [C, A])
      .then((r) => r.rowCount),
  ).resolves.toBe(0);
  expect((await readAgentCommands(rootFixture.db, A, C)).commands).toHaveLength(0);

  // Only the worker result releases the review wake.
  await result(workerCommand!,'The work is ready.');
  await advanceCorner(rootFixture.db, C, { kind: 'reconcile' });
  expect(await commands(A, C)).toHaveLength(1);

  // This suite shares one store, so leave none of the above behind.
  await rootFixture.db.query(`DELETE FROM agent_commands`);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"passing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
});

it('wakes the implementer without consuming a green transition when the configured reviewer is not a parent member', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    A,
  ]);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"passing","pr":{"number":1,"headSha":"action-head"}}' WHERE corner_id=$1`,
    [C],
  );
  await systemLine(rootFixture.db, {
    roomId: C,
    subject: { kind: 'person', id: H, name: 'Human' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
  expect((await readAgentCommands(rootFixture.db, A, C)).commands).toHaveLength(0);
  const handback = await commands(B, C);
  expect(handback.map(command => command.reason).sort()).toEqual(['corner_review_needed', 'report']);
  const needed = handback.find(command => command.reason === 'corner_review_needed');
  expect(needed?.source.body).toContain('the configured reviewer is unreachable');
  expect(needed?.source.body).toContain('report the blocker to its commander');
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%could not be reached%'`, [C])).rowCount).toBe(0);
  await expect(
    rootFixture.daemon.execute('getAgentConfiguration', { agentId: B, roomId: C }, B),
  ).resolves.toEqual(expect.objectContaining({ reviewerHandle: 'hoots' }));
});

it('keeps reviewer subscriptions mandatory and reconciles an unreviewed green head', async () => {
  const headSha = '7'.repeat(40);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 17, url: 'https://github.com/acme/repo/pull/17', headSha },
      }),
    ],
  );
  const source = await systemLine(rootFixture.db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
    object: { text: 'BODY SUITE', headSha },
  });
  await rootFixture.db.query(`DELETE FROM agent_commands`);
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
  for (const roomId of [R, C]) {
    await expect(
      rootFixture.daemon.execute('setEventSubscriptions', { roomId, kinds: [] }, A),
    ).resolves.toEqual({ kinds: ['check-passed'] });
  }
  await rootFixture.db.query(`DELETE FROM agent_subscriptions WHERE source='room' AND agent_id=$1`, [
    A,
  ]);

  await expect(reconcileConfiguredCornerReviewers(rootFixture.db, R)).resolves.toEqual({
    subscriptions: 1,
    commands: 1,
  });
  expect(await commands(A, C)).toEqual([
    expect.objectContaining({ reason: 'corner_review_dispatch' }),
  ]);
  await expect(reconcileConfiguredCornerReviewers(rootFixture.db, R)).resolves.toEqual({
    subscriptions: 0,
    commands: 0,
  });
});

// Reproduction RG-1: a stored GitHub note and a passing lifecycle have no
// check-passed fact, so no configured reviewer receives a command.
it('recovers a green head whose earlier GitHub note never dispatched its reviewer', async () => {
  const headSha = '8'.repeat(40);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 18, url: 'https://github.com/acme/repo/pull/18', headSha },
      }),
    ],
  );
  await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
  await systemLine(rootFixture.db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    object: { text: 'BODY SUITE', headSha },
  });

  await expect(reconcileConfiguredCornerReviewers(rootFixture.db, R)).resolves.toEqual({
    subscriptions: 1,
    commands: 1,
  });
  expect(await commands(A, C)).toEqual([expect.objectContaining({ reason: 'corner_review_dispatch' })]);
  await expect(reconcileConfiguredCornerReviewers(rootFixture.db, R)).resolves.toEqual({
    subscriptions: 0,
    commands: 0,
  });
});

it('runs revised-brief refusal, repair, rereview, exact-head approval, and implementer clearance as commands', async () => {
  const firstHead = '1'.repeat(40);
  const approvedHead = '2'.repeat(40);
  await rootFixture.db.query(
    `INSERT INTO corner_brief_revisions(
       corner_id,revision,content,intent_verbatim,build_spec,criteria,non_goals,
       brief_references,approval_basis,revision_hash,author_id,source_room_id,source_message_id
     ) VALUES
       ($1,1,'Build the full release card',$2::jsonb,'Build the full release card',$3::jsonb,
        '[]'::jsonb,'[]'::jsonb,$4::jsonb,$5,$6,$7,'intent-1'),
       ($1,2,'Build the corrected full release card',$8::jsonb,'Build the corrected full release card',$9::jsonb,
        '[]'::jsonb,'[]'::jsonb,$10::jsonb,$11,$6,$7,'correction-1')`,
    [
      C,
      JSON.stringify([{ sourceMessageId: 'intent-1', snapshot: 'Show status and owner.' }]),
      JSON.stringify([
        { id: 'AC-1', text: 'Show status.' },
        { id: 'AC-2', text: 'Show the corrected owner label from the approved mock.' },
      ]),
      JSON.stringify({
        kind: 'initiating-command',
        sourceMessageId: 'intent-1',
        snapshot: 'Show status and owner.',
        approvedBy: H,
        briefHash: '3'.repeat(64),
      }),
      '3'.repeat(64),
      B,
      R,
      JSON.stringify([
        { sourceMessageId: 'intent-1', snapshot: 'Show status and owner.' },
        { sourceMessageId: 'correction-1', snapshot: 'Correction: label it Responsible owner.' },
      ]),
      JSON.stringify([
        { id: 'AC-1', text: 'Show status.' },
        { id: 'AC-2', text: 'Show Responsible owner exactly as in the approved mock.' },
      ]),
      JSON.stringify({
        kind: 'explicit-human-answer',
        sourceMessageId: 'correction-1',
        snapshot: 'Correction: label it Responsible owner.',
        approvedBy: H,
        briefHash: '4'.repeat(64),
      }),
      '4'.repeat(64),
    ],
  );
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: A }, H);
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: firstHead },
      }),
    ],
  );
  for (let n = 0; n < 2; n++)
    await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      kind: 'check-passed',
    });
  const [firstReview] = await commands(A, C);
  expect(firstReview?.reason).toBe('corner_review_dispatch');
  expect(await commands(A, C)).toHaveLength(1);
  await claim(firstReview!);
  await result(
    firstReview!,
    '@goosy PROD-AC-2-1 [AC-2] confirmed: the partial PR omits the corrected Responsible owner label; repair and preserve this finding ID.',
  );

  const fix = (await commands(B,C)).find(command=>command.reason==='agent_tag');
  expect(fix?.reason).toBe('agent_tag');
  await claim(fix!);
  await result(fix!, 'Pushed the fix');
  await rootFixture.db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks: 'passing',
        lifecycle: 'in-review',
        pr: { number: 7, url: 'https://github.com/acme/repo/pull/7', headSha: approvedHead },
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
  const secondReview=(await commands(A,C)).find(command=>command.reason==='corner_review_dispatch');
  await claim(secondReview!, 'g2');
  await expect(
    rootFixture.daemon.execute(
      'approveCornerMerge',
      { cornerId: C, headSha: approvedHead },
      A,
    ),
  ).resolves.toEqual({ status: 'approved', pullRequestNumber: 7, headSha: approvedHead });
  await result(secondReview!, `@goosy approved ${approvedHead}, merge`, 'g2');

  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM corner_merge_approvals
         WHERE corner_id=$1 AND approved_by=$2 AND pull_request_number=7 AND head_sha=$3`,
        [C, A, approvedHead],
      )
    ).rowCount,
  ).toBe(1);
  // The server lands a PASS itself; the implementer hears only the reviewer's tag.
  const implementerBodies = (await commands(B, C)).map((command) => command.source.body);
  expect(implementerBodies).toEqual(
    expect.arrayContaining([expect.stringContaining(`@goosy approved ${approvedHead}, merge`)]),
  );
  expect(implementerBodies).not.toContain('@system handed off review');
});

it('wakes no parent Room agent on a corner merge without a merged subscription', async () => {
  await landCorner('Do work');
  // B opened the corner; opening it no longer earns a turn when it lands.
  expect(await commands(B, R)).toEqual([]);
  expect(await commands(A, R)).toEqual([]);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [R])).rowCount).toBe(0);
});

it('ignores legacy Room merged subscriptions; lifecycle watches own merge delivery', async () => {
  await rootFixture.db.query(`UPDATE memberships SET event_subscriptions='["merged"]'::jsonb WHERE room_id=$1 AND identity_id=$2`, [R, A]);
  await landCorner('Ship the widget');
  expect(await commands(A, R)).toEqual([]);
  expect(await commands(B, R)).toEqual([]);
});

it('records its own corner objective without a second wake or resetting the authorized chain', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const opened = await rootFixture.daemon.execute(
    'createCorner',
    { roomId: R, requestId: c!.turnRequestId, name: 'Task', objective: 'Do this task' },
    A,
  );
  expect((await commands(A, opened.cornerId)).map(c => c.reason)).toEqual(['corner_objective']);
  expect((await rootFixture.db.query(`SELECT reason,root_command_id,parent_command_id,agent_depth,state,
    private_payload->>'objective' objective FROM agent_commands WHERE room_id=$1 AND reason='corner_objective'`,
    [opened.cornerId])).rows).toEqual([{reason:'corner_objective',root_command_id:c!.id,
      parent_command_id:c!.id,agent_depth:c!.agentDepth,state:'pending',objective:'Do this task'}]);
  // B is a member (it can read the corner and answer when tagged) but the
  // objective is not its work: no intake command.
  expect(await commands(B, opened.cornerId)).toEqual([]);
  expect(
    (
      await rootFixture.db.query<{ event_subscriptions: string[] }>(
        `SELECT event_subscriptions FROM room_access WHERE room_id=$1 AND identity_id=$2`,
        [opened.cornerId, B],
      )
    ).rows,
  ).toEqual([{ event_subscriptions: ['check-passed'] }]);
});

it('makes the depth boundary explicit', () => {
  expect([0, 1, 2, 3, 50].map(nextAgentDepth)).toEqual([1, 2, 3, 4, 51]);
});


it.each(['absent', 'stale', 'offline'] as const)(
  'keeps exactly one pending command while helper presence is %s and permits claim after return',
  async (presence) => {
    if (presence === 'absent')
      await rootFixture.db.query(`DELETE FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [A]);
    else if (presence === 'stale')
      await rootFixture.db.query(
        `UPDATE live_outputs SET body='{"status":"online"}',updated_at=now()-interval '10 minutes' WHERE agent_id=$1 AND kind='presence'`,
        [A],
      );
    else
      await rootFixture.db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [A]);

    const messageId = id();
    for (let attempt = 0; attempt < 2; attempt++)
      await rootFixture.phone.execute(
        'sendRoomMessage',
        { roomId: R, text: '@hoots are you there?', messageId },
        H,
      );
    expect(
      (
        await rootFixture.db.query<{ state: string }>(
          `SELECT state FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
          [messageId, A],
        )
      ).rows,
    ).toEqual([{ state: 'pending' }]);

    await rootFixture.db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence','{"status":"online"}')
       ON CONFLICT(room_id,agent_id,turn_id,kind)
       DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [R, A],
    );
    const [command] = await commands();
    expect(command?.sourceMessageId).toBe(messageId);
    await startQueuedCommand(rootFixture.daemon, { roomId: R, commandId: command!.id }, A);
    expect(
      (
        await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [
          command!.id,
        ])
      ).rows[0]?.state,
    ).toBe('pending');
  },
);


it('keeps a mention queued without a premature offline notice during restart', async () => {
  await rootFixture.db.query(`UPDATE live_outputs SET body='{"status":"offline"}' WHERE agent_id=$1`, [A]);
  const source = await send('@hoots are you there?');
  expect(await commands()).toHaveLength(1);
  expect(
    (
      await rootFixture.db.query(
        `SELECT text FROM messages WHERE room_id=$1 AND presentation='system' AND text LIKE '%helper is offline%'`,
        [R],
      )
    ).rowCount,
  ).toBe(0);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE id=$1`, [source.messageId])).rowCount).toBe(
    1,
  );
  await rootFixture.db.query(`UPDATE live_outputs SET body='{"status":"online"}' WHERE agent_id=$1`, [A]);
  const [command] = await commands();
  await claim(command!, 'reconnected');
  await result(command!, 'I am here.', 'reconnected');
  expect((await rootFixture.phone.readRoom(R, H))?.messages).toContainEqual(
    expect.objectContaining({ text: 'I am here.' }),
  );
});



it('atomically establishes the working receipt when an input command is claimed', async () => {
  await send('@hoots');
  const [c] = await commands();
  await startQueuedCommand(rootFixture.daemon, { roomId: R, commandId: c!.id }, A);
  expect(
    (
      await rootFixture.db.query(
        `SELECT status FROM agent_turns
         WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
        [R, c!.turnRequestId, A],
      )
    ).rows,
  ).toEqual([{ status: 'working' }]);
  expect((await rootFixture.phone.readRoom(R, H))?.latestAgentTurns).toContainEqual(
    expect.objectContaining({
      requestId: c!.turnRequestId,
      agentPubkey: A,
      status: 'working',
    }),
  );
});

it('an approval decision gets its own queue item and delivery clock',async()=>{
  await send('@hoots');const [original]=await commands();await claim(original!);await result(original!,'Waiting for approval.');
  await rootFixture.db.query("UPDATE agent_turns SET started_at=now()-interval '57 hours' WHERE request_id=$1",[original!.turnRequestId]);
  const decision=id();await rootFixture.db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'approved')",[decision,R,H]);
  const resumed=(await createAgentCommand(rootFixture.db,{roomId:R,agentId:A,sourceMessageId:decision,reason:'resume'}))!;
  expect(resumed.action).toBe('input');expect(resumed.turn_request_id).toBe(decision);expect(resumed.turn_request_id).not.toBe(original!.turnRequestId);
  await startQueuedCommand(rootFixture.daemon,{roomId:R,commandId:resumed.id},A);
  expect((await rootFixture.db.query('SELECT status FROM agent_turns WHERE request_id=$1',[original!.turnRequestId])).rows).toEqual([{status:'complete'}]);
  expect((await rootFixture.db.query("SELECT status,started_at>now()-interval '1 hour' fresh FROM agent_turns WHERE request_id=$1",[resumed.turn_request_id])).rows).toEqual([{status:'working',fresh:true}]);
});
