import { describe, expect, it, vi, REVIEW_IDENTITY_ID, startQueuedTurn, createAgentCommand, DaemonService, LiveHub, dashboardCoreMetrics, workspace, room, secret, db, get, coreWorkspace, coreRoom, secondWorkspace, coreMeasuredAt, coreId, coreAt, easternDay, shiftEasternDay, corePoint, rootFixture, fixtureScope3 } from './test-support-operator-dashboard.test-support.js';



it('R-periods: serves distinct activity, four signup funnels and one platform per person over HTTP', async () => {
  const now = new Date('2026-10-23T19:15:00.000Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await rootFixture.db.query("UPDATE workspaces SET created_at=$1::timestamptz-interval '1 hour' WHERE id=$2", [
    now.toISOString(),
    workspace,
  ]);
  for (const [index, age] of [0.5, 3, 14, 40].entries()) {
    const human = `c${index.toString(16).padStart(63, '0')}`,
      agent = `d${index.toString(16).padStart(63, '0')}`;
    const created = new Date(now.getTime() - age * 86400000).toISOString();
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name,created_at) VALUES($1,'human','Customer',$3),($2,'agent','Helper',$3)`,
      [human, agent, created],
    );
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [
      workspace,
      human,
    ]);
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'hello',$4)`,
      [`period-first-${index}`, room, human, created],
    );
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'reply',$4::timestamptz+interval '1 minute')`,
      [`period-reply-${index}`, room, agent, created],
    );
  }
  // The same person contributes to several daily buckets but only one headline.
  for (const age of [1, 2, 3])
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,'c000000000000000000000000000000000000000000000000000000000000000','again',$3)`,
      [`repeat-${age}`, room, new Date(now.getTime() - age * 86400000).toISOString()],
    );
  await rootFixture.db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment,updated_at) VALUES('period-ios','c000000000000000000000000000000000000000000000000000000000000000','ios','physical',$1::timestamptz-interval '1 day')`,
    [now.toISOString()],
  );
  await rootFixture.db.query(
    `INSERT INTO device_update_receipts(identity_id,device_id,receipt,reported_at) VALUES('c000000000000000000000000000000000000000000000000000000000000000','newest','{"platform":"web"}',$1)`,
    [now.toISOString()],
  );
  const response = await get();
  expect(response.status).toBe(200);
  const body = await response.json();
  const fixtureResponse = { periods: body.periods, platformBreakdown: body.platformBreakdown };
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/operator-dashboard-periods.json', import.meta.url), 'utf8'),
  );
  expect(fixtureResponse).toEqual(fixture);
  expect(body.platforms).toEqual(['ios', 'android', 'web', 'macos', 'windows', 'linux']);
  for (const [key, count] of Object.entries({
    '24h': 1,
    '7d': 2,
    '28d': 3,
    all: 4,
  })) {
    const period = body.periods[key];
    expect(period.active.people).toBe(count);
    expect(period.growth.newPeople).toBe(count);
    expect(period.funnel.steps.slice(0, 4).map((s: { count: number }) => s.count)).toEqual([
      count,
      count,
      count,
      count,
    ]);
    const counts = period.funnel.steps.map((s: { count: number }) => s.count);
    expect(counts.every((n: number, i: number) => i === 0 || n <= counts[i - 1])).toBe(true);
    expect(period.active.series.length).toBeGreaterThan(0);
  }
  expect(
    body.periods['7d'].active.series.reduce(
      (sum: number, p: { value: number }) => sum + p.value,
      0,
    ),
  ).toBeGreaterThan(2);
  expect(body.periods['24h'].funnel.biggestDrop).toBeNull();
  expect(body.periods['28d'].funnel.biggestDrop).toEqual({ key: 'active_7d', lost: 1 });
  expect(body.platformBreakdown).toEqual({
    basis: 'last_device',
    counts: [
      { platform: 'unknown', people: 3 },
      { platform: 'web', people: 1 },
    ],
  });
});


it('keeps period funnels conditional and excludes internal, hidden and review activity', async () => {
  const person = 'e'.repeat(64),
    hidden = 'f'.repeat(64);
  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES($1,'human','Customer',false),($2,'human','Hidden',true),($3,'human','Review',false) ON CONFLICT DO NOTHING`,
    [person, hidden, REVIEW_IDENTITY_ID],
  );
  await rootFixture.db.query(
    `INSERT INTO memberships(workspace_id,identity_id,role,removed_at) VALUES($1,$2,'member',now())`,
    [workspace, person],
  );
  for (const id of [person, hidden, REVIEW_IDENTITY_ID])
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`, [
      `excluded-${id}`,
      room,
      id,
    ]);
  const body = await (await get()).json();
  expect(body.periods['24h'].active.people).toBe(1);
  expect(body.periods['24h'].funnel.steps.map((s: { count: number }) => s.count)).toEqual([
    1, 0, 0, 0, 0,
  ]);
  expect(body.periods['24h'].funnel.biggestDrop).toEqual({
    key: 'joined_workspace',
    lost: 1,
  });
  expect(body.platformBreakdown.counts).toEqual([{ platform: 'unknown', people: 1 }]);
  await rootFixture.db.query(`UPDATE workspaces SET internal=true WHERE id=$1`, [workspace]);
  const internal = await (await get()).json();
  expect(internal.periods.all.active.people).toBe(0);
  expect(internal.periods.all.growth.newPeople).toBe(0);
  expect(internal.platformBreakdown.counts).toEqual([]);
});


it.each(['2026-03-09T12:30:00Z', '2026-11-02T12:30:00Z'])(
  'uses Eastern midnight across DST for period charts at %s',
  async (measuredAt) => {
    const { dashboardPeriods } = await import('./operator-dashboard-periods.js');
    const person = 'e'.repeat(64);
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name,created_at) VALUES($1,'human','Customer',$2::timestamptz-interval '5 days')`,
      [person, measuredAt],
    );
    const periods = await dashboardPeriods(rootFixture.db, measuredAt);
    const daily = periods['7d']!.active.series as {
      start: string;
      value: number;
    }[];
    const intervals = daily
      .slice(1)
      .map((p, i) => (Date.parse(p.start) - Date.parse(daily[i]!.start)) / 3600000);
    expect(intervals).toContain(measuredAt.includes('03-') ? 23 : 25);
    expect(intervals.every((n) => [23, 24, 25].includes(n))).toBe(true);
    expect((periods['24h']!.active.series as unknown[]).length).toBe(25);
  },
);


it('clips rolling period buckets at the exact window and measurement boundaries', async () => {
  const { dashboardPeriods } = await import('./operator-dashboard-periods.js');
  const measuredAt = '2026-10-23T19:15:00Z';
  const person = 'e'.repeat(64);
  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,created_at) VALUES($1,'human','Customer','2026-10-01')`,
    [person],
  );
  for (const [index, at] of [
    '2026-10-22T19:14:59Z',
    '2026-10-22T19:15:00Z',
    '2026-10-23T19:14:59Z',
    '2026-10-23T19:15:00Z',
  ].entries()) {
    await rootFixture.db.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'hello',$4)`,
      [`edge-${index}`, room, person, at],
    );
  }
  const periods = await dashboardPeriods(rootFixture.db, measuredAt);
  expect(periods['24h']!.active.people).toBe(1);
  expect(periods['24h']!.active.messages).toBe(2);
  expect(periods['24h']!.growth.newPeople).toBe(0);
  const series = periods['24h']!.active.series as { start: string; value: number }[];
  expect(Date.parse(series[0]!.start)).toBe(Date.parse('2026-10-22T19:00:00Z'));
  expect(series[0]!.value).toBe(1);
  expect(series.at(-1)!.value).toBe(1);
});


it('requires an owned agent reply strictly after the first retained production message', async () => {
  const human = 'e'.repeat(64),
    agent = 'd'.repeat(64);
  await rootFixture.db.query(
    `INSERT INTO identities(id,kind,name,created_at) VALUES($1,'human','Customer',now()-interval '10 days'),($2,'agent','Helper',now()-interval '10 days')`,
    [human, agent],
  );
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [
    workspace,
    human,
  ]);
  await rootFixture.db.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('sequence-human',$1,$2,'hello',now()-interval '2 days'),('sequence-agent',$1,$3,'early',now()-interval '3 days')`,
    [room, human, agent],
  );
  const counts = async () =>
    (await (await get()).json()).periods['28d'].funnel.steps.map((s: { count: number }) => s.count);
  expect(await counts()).toEqual([1, 1, 1, 0, 0]);
  await rootFixture.db.query(`UPDATE messages SET created_at=now()-interval '1 day' WHERE id='sequence-agent'`);
  expect(await counts()).toEqual([1, 1, 1, 1, 1]);
  await rootFixture.db.query(`UPDATE messages SET deleted_at=now() WHERE id='sequence-agent'`);
  expect(await counts()).toEqual([1, 1, 1, 0, 0]);
});
describe('core metrics', () => {
const scope3 = fixtureScope3();


  it('counts the five operator metrics, drops internal workspaces, and keeps unknown history null', async () => {
    await rootFixture.db.query(`INSERT INTO workspaces(id,name,internal) VALUES($1,'Internal',true)`, [coreWorkspace]);
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Internal')`, [coreRoom, coreWorkspace]);
    await rootFixture.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second')`, [secondWorkspace]);
    await rootFixture.db.query(
      `UPDATE operator_metric_epochs SET started_at=$1 WHERE metric IN ('invite','agent_pairing')`,
      ['2026-10-01T16:00:00.000Z'],
    );
    await scope3.person(scope3.A, 'ios');
    await scope3.person(scope3.B, 'ios');
    await scope3.person(scope3.BOTH, 'ios');
    await scope3.join(scope3.BOTH, coreWorkspace);
    await scope3.person(scope3.INTERNAL, 'ios', coreAt('2026-10-20'), coreWorkspace);
    await scope3.person(scope3.ANDROID, 'android', coreAt('2026-10-20'));
    await scope3.person(scope3.NULL_INVITE, 'ios');
    await scope3.person(scope3.STARTERS, 'ios');
    await scope3.person(scope3.DELETED, 'ios');
    await scope3.person(scope3.F, 'ios', coreAt('2026-10-20'));
    await scope3.person(scope3.G, 'ios', coreAt('2026-10-20'));
    await scope3.person(scope3.H, 'ios', coreAt('2026-10-26'));
    await scope3.person(scope3.I, 'ios', coreAt('2026-10-20'));
    await scope3.person(scope3.J, 'ios', coreAt('2026-10-20'));
    await scope3.person(scope3.K, 'ios');
    await scope3.person(scope3.L, 'ios');
    for (const [n, at] of [[scope3.A1, coreAt('2026-10-21')], [scope3.A2, coreAt('2026-10-21')], [scope3.B1, coreAt('2026-10-21')]] as const) {
      await scope3.identity(n, 'human');
      await scope3.join(n, workspace, at, n === scope3.B1 ? scope3.B : scope3.A);
    }
    await scope3.identity(scope3.ROOM_INVITEE, 'human');
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,joined_at,invited_by)
       VALUES($1,$2,$3,'member',$4,$5)`,
      [workspace, room, coreId(scope3.ROOM_INVITEE), coreAt('2026-10-21'), coreId(scope3.A)],
    );
    await scope3.identity(scope3.AGENT_INVITEE, 'agent');
    await scope3.join(scope3.AGENT_INVITEE, workspace, coreAt('2026-10-21'), scope3.A);

    await scope3.invite('a-oct1', scope3.A, workspace, coreAt('2026-10-01', 12));
    await scope3.invite('a-oct19', scope3.A, workspace, coreAt('2026-10-19'));
    await scope3.invite('a-oct20', scope3.A, workspace, coreAt('2026-10-20'));
    await scope3.invite('a-onboarding', scope3.A, workspace, coreAt('2026-10-20'), true);
    await scope3.invite('a-oct21', scope3.A, workspace, coreAt('2026-10-21'));
    await scope3.invite('a-oct22', scope3.A, workspace, coreAt('2026-10-22'));
    await scope3.invite('a-sept', scope3.A, workspace, coreAt('2026-09-15'));
    await scope3.invite('a-null', scope3.A, workspace, null);
    await scope3.invite('b-oct20', scope3.B, workspace, coreAt('2026-10-20'));
    await scope3.invite('both-internal', scope3.BOTH, coreWorkspace, coreAt('2026-10-20'));
    await scope3.invite('internal-only', scope3.INTERNAL, coreWorkspace, coreAt('2026-10-20'));
    await scope3.invite('android', scope3.ANDROID, workspace, coreAt('2026-10-20'));
    await scope3.invite('null-only', scope3.NULL_INVITE, workspace, null);

    await scope3.ownAgent(scope3.FREE, scope3.F, { free: true });
    await scope3.ownAgent(scope3.G_AGENT, scope3.G);
    await scope3.ownAgent(scope3.H_AGENT, scope3.H);
    await scope3.ownAgent(scope3.J_AGENT, scope3.J);
    await scope3.ownAgent(scope3.K_AGENT, scope3.K, { roomMember: true });
    await scope3.ownAgent(scope3.L_AGENT, scope3.L);
    await scope3.ownAgent(scope3.ANDROID_AGENT, scope3.ANDROID);
    await scope3.ownAgent(scope3.INTERNAL_AGENT, scope3.INTERNAL, { free: true });
    await scope3.ownAgent(scope3.ANDROID_FREE, scope3.ANDROID, { free: true });
    await scope3.say('f-reply', scope3.FREE, coreAt('2026-10-20'));
    await scope3.say('f-return', scope3.F, coreAt('2026-10-21'));
    await scope3.say('g-reply', scope3.G_AGENT, coreAt('2026-10-20'));
    await scope3.say('g-internal-return', scope3.G, coreAt('2026-10-21'), coreRoom);
    await scope3.say('h-reply', scope3.H_AGENT, coreAt('2026-10-26'));
    await scope3.say('h-return', scope3.H, coreAt('2026-10-27'));
    await scope3.say('j-internal-reply', scope3.J_AGENT, coreAt('2026-10-20'), coreRoom);
    await scope3.say('internal-reply', scope3.INTERNAL_AGENT, coreAt('2026-10-20'), coreRoom);
    await scope3.say('android-reply', scope3.ANDROID_AGENT, coreAt('2026-10-20'));

    await scope3.pairing('k-oct1', scope3.K, workspace, coreAt('2026-10-01', 12));
    await scope3.pairing('k-oct20-a', scope3.K, workspace, coreAt('2026-10-20'));
    await scope3.pairing('k-oct20-b', scope3.K, workspace, coreAt('2026-10-20'));
    await scope3.pairing('k-oct21', scope3.K, workspace, coreAt('2026-10-21'));
    await scope3.pairing('k-oct22', scope3.K, workspace, coreAt('2026-10-22'));
    await scope3.pairing('k-sept', scope3.K, workspace, coreAt('2026-09-15'));
    await scope3.pairing('k-null', scope3.K, workspace, null);
    await scope3.pairing('both-internal', scope3.BOTH, coreWorkspace, coreAt('2026-10-20'));
    await scope3.pairing('android', scope3.ANDROID, workspace, coreAt('2026-10-20'));
    await scope3.pairing('internal', scope3.INTERNAL, coreWorkspace, coreAt('2026-10-20'));
    for (const [n, agentId, at, revoked] of [
      [1, scope3.K_AGENT, coreAt('2026-10-21'), false],
      [2, scope3.K_AGENT, coreAt('2026-10-22'), false],
      [3, scope3.L_AGENT, coreAt('2026-10-20'), true],
      [4, scope3.L_AGENT, coreAt('2026-10-22'), false],
      [5, scope3.L_AGENT, coreAt('2026-10-23'), false],
      [6, scope3.FREE, coreAt('2026-10-20'), false],
      [7, scope3.ANDROID_AGENT, coreAt('2026-10-21'), false],
      [8, scope3.INTERNAL_AGENT, coreAt('2026-10-21'), false],
    ] as const) {
      await rootFixture.db.query(
        `INSERT INTO daemon_tokens(token_hash,agent_id,created_at,revoked_at) VALUES($1,$2,$3,$4)`,
        [n.toString(16).padStart(64, 'd'), coreId(agentId), at, revoked ? at : null],
      );
    }

    await scope3.repoCard('k-card-19', scope3.K, coreAt('2026-10-19'), 'repository');
    await scope3.repoCard('k-card-20a', scope3.K, coreAt('2026-10-20'), 'repository');
    await scope3.repoCard('k-card-20b', scope3.K, coreAt('2026-10-20'), 'repository');
    await scope3.repoCard('k-starters', scope3.K, coreAt('2026-10-20'), 'starters');
    await scope3.repoCard('starters-only', scope3.STARTERS, coreAt('2026-10-20'), 'starters');
    await scope3.repoCard('deleted', scope3.DELETED, coreAt('2026-10-20'), 'repository', room, true);
    await scope3.repoCard('internal-card', scope3.BOTH, coreAt('2026-10-20'), 'repository', coreRoom);
    await scope3.repoCard('android-card', scope3.ANDROID, coreAt('2026-10-20'), 'repository');
    await scope3.repoCard('internal-person-card', scope3.INTERNAL, coreAt('2026-10-20'), 'repository', coreRoom);
    for (const [ws, at] of [
      [workspace, coreAt('2026-10-21')],
      [secondWorkspace, coreAt('2026-10-21')],
      [coreWorkspace, coreAt('2026-10-21')],
    ] as const) {
      await rootFixture.db.query(
        `INSERT INTO repository_link_successes(identity_id,workspace_id,first_linked_at) VALUES($1,$2,$3)`,
        [coreId(scope3.K), ws, at],
      );
    }
    await rootFixture.db.query(
      `INSERT INTO repository_link_successes(identity_id,workspace_id,first_linked_at) VALUES($1,$2,$3)`,
      [coreId(scope3.ANDROID), workspace, coreAt('2026-10-21')],
    );

    const daemon = new DaemonService(rootFixture.db, new LiveHub());
    const receipt = async (
      requestId: string,
      tokens: { inputTokens?: number; totalInputTokens?: number; outputTokens?: number },
    ) => {
      await rootFixture.db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@agent')`,
        [requestId, room, coreId(scope3.K)],
      );
      const command = await createAgentCommand(rootFixture.db, {
        id: requestId,
        roomId: room,
        agentId: coreId(scope3.K_AGENT),
        sourceMessageId: requestId,
        reason: 'human_tag',
      });
      await startQueuedTurn(rootFixture.db, room, coreId(scope3.K_AGENT), command!.id);
      await daemon.execute('postRoomMessage', { roomId: room, requestId, text: 'Measured answer.' }, coreId(scope3.K_AGENT));
      await rootFixture.db.backgroundWork.drain();
      await daemon.execute('postAgentTurnReceipt', { roomId: room, requestId, status: 'complete', agentId: coreId(scope3.K_AGENT), ...tokens }, coreId(scope3.K_AGENT));
    };
    await receipt('core-measured', { inputTokens: 10, totalInputTokens: 1000, outputTokens: 200 });
    await receipt('core-bare', {});
    await receipt('core-bad', { totalInputTokens: 1.5, outputTokens: -1 });
    await rootFixture.db.query(`UPDATE agent_turns SET created_at=$2 WHERE request_id=$1`, ['core-measured', coreAt('2026-10-20')]);
    await rootFixture.db.query(`UPDATE agent_turns SET created_at=$2 WHERE request_id=$1`, ['core-bare', coreAt('2026-10-21')]);
    await rootFixture.db.query(`UPDATE agent_turns SET created_at=$2 WHERE request_id=$1`, ['core-bad', coreAt('2026-10-21')]);
    for (const [request, agentId, at, input, output, roomId] of [
      ['sql-unmeasured', scope3.K_AGENT, coreAt('2026-10-20'), null, null, room],
      ['sql-oct26', scope3.K_AGENT, coreAt('2026-10-26'), 200, null, room],
      ['sql-oct27', scope3.K_AGENT, coreAt('2026-10-27'), 300, 100, room],
      ['sql-free', scope3.FREE, coreAt('2026-10-20'), 5000, 0, room],
      ['sql-internal', scope3.K_AGENT, coreAt('2026-10-20'), 9999, 0, coreRoom],
      ['sql-android', scope3.ANDROID_AGENT, coreAt('2026-10-20'), 7777, 0, room],
    ] as const) {
      await rootFixture.db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at,input_tokens,output_tokens)
         VALUES($1,$2,$3,'complete',$4,$5,$6)`,
        [roomId, request, coreId(agentId), at, input, output],
      );
    }
    for (const [agentId, at, tokens, kind] of [
      [scope3.FREE, coreAt('2026-10-20'), 100, 'model_usage'],
      [scope3.FREE, coreAt('2026-10-20'), 50, 'model_usage'],
      [scope3.FREE, coreAt('2026-10-20'), 'nope', 'model_usage'],
      [scope3.FREE, coreAt('2026-10-20'), 5000, 'sleep'],
      [scope3.FREE, coreAt('2026-10-26'), 100, 'model_usage'],
      [scope3.FREE, coreAt('2026-10-27'), 200, 'model_usage'],
      [scope3.INTERNAL_AGENT, coreAt('2026-10-20'), 999, 'model_usage'],
      [scope3.ANDROID_FREE, coreAt('2026-10-20'), 888, 'model_usage'],
    ] as const) {
      await rootFixture.db.query(
        `INSERT INTO free_agent_events(agent_id,kind,at,detail) VALUES($1,$2,$3,$4::jsonb)`,
        [coreId(agentId), kind, at, JSON.stringify({ tokens })],
      );
    }

    const stored = await rootFixture.db.query<{ request_id: string; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT request_id,input_tokens,output_tokens FROM agent_turns
       WHERE request_id IN ('core-measured','core-bare','core-bad') ORDER BY request_id`,
    );
    expect(stored.rows).toEqual([
      { request_id: 'core-bad', input_tokens: null, output_tokens: null },
      { request_id: 'core-bare', input_tokens: null, output_tokens: null },
      { request_id: 'core-measured', input_tokens: 1000, output_tokens: 200 },
    ]);

    const metrics = await dashboardCoreMetrics(rootFixture.db, ['ios'], coreMeasuredAt);
    expect(metrics.invites.state).toBe('measured');
    expect(metrics.onboarding.state).toBe('measured');
    expect(metrics.ownAgents.state).toBe('measured');
    expect(metrics.repositories.state).toBe('measured');
    expect(metrics.tokens.state).toBe('measured');
    if (metrics.invites.state !== 'measured' || metrics.onboarding.state !== 'measured'
      || metrics.ownAgents.state !== 'measured' || metrics.repositories.state !== 'measured'
      || metrics.tokens.state !== 'measured') return;

    const invites = metrics.invites.data;
    const onboarding = metrics.onboarding.data;
    const own = metrics.ownAgents.data;
    const repos = metrics.repositories.data;
    const tokens = metrics.tokens.data;
    expect(invites.daily).toHaveLength(90);
    expect(invites.since).toBe('2026-10-01T16:00:00.000Z');
    expect(own.since).toBe('2026-10-01T16:00:00.000Z');
    expect(corePoint(invites.daily, '2026-09-15')).toMatchObject({ inviters: null, invitesAccepted: 0 });
    expect(corePoint(invites.daily, '2026-10-01')).toMatchObject({ inviters: 1, invitesAccepted: 0 });
    expect(corePoint(invites.daily, '2026-10-02')).toMatchObject({ inviters: 0, invitesAccepted: 0 });
    expect(corePoint(invites.daily, '2026-10-19')).toMatchObject({ inviters: 1 });
    expect(corePoint(invites.daily, '2026-10-20')).toMatchObject({ inviters: 2, invitesAccepted: 0 });
    expect(corePoint(invites.daily, '2026-10-21')).toMatchObject({ inviters: 1, invitesAccepted: 2 });
    expect(corePoint(invites.daily, '2026-10-22')).toMatchObject({ inviters: 1 });
    expect(corePoint(invites.daily, '2026-10-27')).toMatchObject({ inviters: 0, invitesAccepted: 0 });
    expect(invites.prior7).toEqual({ inviters: 2, invitesAccepted: 0 });
    expect(invites.last7).toEqual({ inviters: 1, invitesAccepted: 2 });

    expect(corePoint(onboarding.daily, '2026-10-20')).toEqual({
      date: '2026-10-20', completedOnboarding: 2, returnedNextDay: 1, eligible: 2,
    });
    expect(corePoint(onboarding.daily, '2026-10-26')).toEqual({
      date: '2026-10-26', completedOnboarding: 1, returnedNextDay: 0, eligible: 0,
    });
    expect(corePoint(onboarding.daily, '2026-10-02')).toMatchObject({
      completedOnboarding: 0, returnedNextDay: 0, eligible: 0,
    });
    expect(onboarding.prior7).toEqual({ completedOnboarding: 2, returnedNextDay: 1, eligible: 2 });
    expect(onboarding.last7).toEqual({ completedOnboarding: 1, returnedNextDay: 0, eligible: 0 });

    expect(corePoint(own.daily, '2026-09-15')).toMatchObject({ connectAttempted: null, connectSucceeded: 0 });
    expect(corePoint(own.daily, '2026-10-01')).toMatchObject({ connectAttempted: 1, connectSucceeded: 0 });
    expect(corePoint(own.daily, '2026-10-02')).toMatchObject({ connectAttempted: 0, connectSucceeded: 0 });
    expect(corePoint(own.daily, '2026-10-20')).toMatchObject({ connectAttempted: 1, connectSucceeded: 0 });
    expect(corePoint(own.daily, '2026-10-21')).toMatchObject({ connectAttempted: 1, connectSucceeded: 1 });
    // L's agent got a daemon token on 10-22 but never took a turn, so it is no success.
    expect(corePoint(own.daily, '2026-10-22')).toMatchObject({ connectAttempted: 1, connectSucceeded: 0 });
    const noConnector = { connectAttempted: 0, connectSucceeded: 0 };
    expect(own.prior7).toEqual({
      connectAttempted: 1, connectSucceeded: 0,
      byRoute: { code: { connectAttempted: 1, connectSucceeded: 0 }, connector: noConnector },
    });
    expect(own.last7).toEqual({
      connectAttempted: 1, connectSucceeded: 1,
      byRoute: { code: { connectAttempted: 1, connectSucceeded: 1 }, connector: noConnector },
    });

    expect(corePoint(repos.daily, '2026-10-19')).toMatchObject({ linkAttempted: 1, linkSucceeded: 0 });
    expect(corePoint(repos.daily, '2026-10-20')).toMatchObject({ linkAttempted: 1, linkSucceeded: 0 });
    expect(corePoint(repos.daily, '2026-10-21')).toMatchObject({ linkAttempted: 0, linkSucceeded: 1 });
    expect(corePoint(repos.daily, '2026-10-02')).toMatchObject({ linkAttempted: 0, linkSucceeded: 0 });
    expect(repos.prior7).toEqual({ linkAttempted: 1, linkSucceeded: 0 });
    expect(repos.last7).toEqual({ linkAttempted: 0, linkSucceeded: 1 });

    expect(corePoint(tokens.daily, '2026-10-20')).toEqual({
      date: '2026-10-20', freeAgentTokens: 150, ownAgentTokens: 1200, ownAgentTurnsUnmeasured: 1,
    });
    expect(corePoint(tokens.daily, '2026-10-21')).toEqual({
      date: '2026-10-21', freeAgentTokens: 0, ownAgentTokens: null, ownAgentTurnsUnmeasured: 2,
    });
    expect(corePoint(tokens.daily, '2026-10-02')).toEqual({
      date: '2026-10-02', freeAgentTokens: 0, ownAgentTokens: 0, ownAgentTurnsUnmeasured: 0,
    });
    expect(corePoint(tokens.daily, '2026-10-26')).toMatchObject({ freeAgentTokens: 100, ownAgentTokens: 200 });
    expect(corePoint(tokens.daily, '2026-10-27')).toMatchObject({ freeAgentTokens: 200, ownAgentTokens: 400 });
    expect(tokens.prior7).toEqual({ freeAgentTokens: 150, ownAgentTokens: 1200, ownAgentTurnsUnmeasured: 1 });
    expect(tokens.last7).toEqual({ freeAgentTokens: 300, ownAgentTokens: 600, ownAgentTurnsUnmeasured: 2 });
    expect(tokens.change).toEqual({
      freeAgentTokens: { dayOverDay: 1, weekOverWeek: 1 },
      ownAgentTokens: { dayOverDay: 1, weekOverWeek: -0.5 },
    });
    const body = JSON.stringify(metrics);
    for (const n of [scope3.A, scope3.B, scope3.F, scope3.K, scope3.INTERNAL, scope3.ANDROID, scope3.NULL_INVITE]) expect(body).not.toContain(coreId(n));
  }, 30_000);


  it('Reproduction CORE-TRUTH: counts outside people only, ties accepted invites to counted invites, and splits connects by route', async () => {
    await rootFixture.db.query(`INSERT INTO workspaces(id,name,internal) VALUES($1,'Internal',true)`, [coreWorkspace]);
    await rootFixture.db.query(
      `UPDATE operator_metric_epochs SET started_at=$1 WHERE metric IN ('invite','agent_pairing')`,
      ['2026-10-01T16:00:00.000Z'],
    );
    await rootFixture.db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('core-client','Claude Code','[]')`);
    const OUT = 50, TEAM = 51, TRIER = 52, OLD_INVITER = 53;
    const connector = async (agentId: number, owner: number, at: string) => {
      await scope3.ownAgent(agentId, owner);
      await rootFixture.db.query(
        `INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,created_at) VALUES('core-client',$1,$2,'Claude',$3)`,
        [coreId(owner), coreId(agentId), at],
      );
      await rootFixture.db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event,created_at)
         VALUES($1,$2,$3,'joined','system','{"kind":"joined"}'::jsonb,$4)`,
        [`joined-${agentId}`, room, coreId(agentId), at],
      );
    };
    // The outside person and a team member do the same things. The team member
    // also belongs to an internal workspace, and every action happens outside it.
    for (const [person, base] of [[OUT, 60], [TEAM, 70]] as const) {
      await scope3.person(person, 'ios', coreAt('2026-10-21', 10));
      if (person === TEAM) await scope3.join(person, coreWorkspace);
      const agent = base, free = base + 1, invitee = base + 2, connected = base + 3;
      await scope3.ownAgent(agent, person);
      await scope3.ownAgent(free, person, { free: true });
      await rootFixture.db.query(
        `INSERT INTO free_agent_events(agent_id,kind,at,detail) VALUES($1,'model_usage',$2,'{"tokens":70}'::jsonb)`,
        [coreId(free), coreAt('2026-10-21')],
      );
      await scope3.invite(`truth-${person}`, person, workspace, coreAt('2026-10-21'));
      await scope3.identity(invitee, 'human');
      await scope3.join(invitee, workspace, coreAt('2026-10-22'), person);
      await scope3.pairing(`truth-${person}`, person, workspace, coreAt('2026-10-21', 11));
      await rootFixture.db.query(
        `INSERT INTO daemon_tokens(token_hash,agent_id,created_at) VALUES($1,$2,$3)`,
        [person.toString(16).padStart(64, 'e'), coreId(agent), coreAt('2026-10-21', 12)],
      );
      await rootFixture.db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at,input_tokens,output_tokens)
         VALUES($1,$2,$3,'complete',$4,400,100)`,
        [room, `truth-${person}`, coreId(agent), coreAt('2026-10-21')],
      );
      await scope3.say(`truth-reply-${person}`, agent, coreAt('2026-10-21'));
      await scope3.repoCard(`truth-card-${person}`, person, coreAt('2026-10-21'), 'repository');
      await rootFixture.db.query(
        `INSERT INTO repository_link_successes(identity_id,workspace_id,first_linked_at) VALUES($1,$2,$3)`,
        [coreId(person), workspace, coreAt('2026-10-22')],
      );
      await connector(connected, person, coreAt('2026-10-23'));
      await scope3.say(`truth-connector-${person}`, connected, coreAt('2026-10-24'));
    }
    // Joined through a connector and never took a turn: a try, not a success.
    await scope3.person(TRIER, 'ios');
    await connector(80, TRIER, coreAt('2026-10-24'));
    // Invites made before invite times were recorded, or before the epoch,
    // count for neither the inviter nor the acceptance.
    await scope3.person(OLD_INVITER, 'ios');
    await scope3.invite('truth-null', OLD_INVITER, workspace, null);
    await scope3.invite('truth-old', OLD_INVITER, workspace, coreAt('2026-09-20'));
    await scope3.identity(81, 'human');
    await scope3.join(81, workspace, coreAt('2026-10-22'), OLD_INVITER);

    const metrics = await dashboardCoreMetrics(rootFixture.db, ['ios'], coreMeasuredAt);
    if (metrics.invites.state !== 'measured' || metrics.onboarding.state !== 'measured'
      || metrics.ownAgents.state !== 'measured' || metrics.repositories.state !== 'measured'
      || metrics.tokens.state !== 'measured') throw new Error('core metrics unavailable');
    expect(metrics.invites.data.last7).toEqual({ inviters: 1, invitesAccepted: 1 });
    expect(corePoint(metrics.invites.data.daily, '2026-10-22')).toMatchObject({ invitesAccepted: 1 });
    expect(metrics.onboarding.data.last7.completedOnboarding).toBe(1);
    expect(metrics.repositories.data.last7).toEqual({ linkAttempted: 1, linkSucceeded: 1 });
    expect(metrics.tokens.data.last7).toEqual({ freeAgentTokens: 70, ownAgentTokens: 500, ownAgentTurnsUnmeasured: 0 });
    expect(metrics.ownAgents.data.last7).toEqual({
      connectAttempted: 2,
      connectSucceeded: 1,
      byRoute: {
        code: { connectAttempted: 1, connectSucceeded: 1 },
        connector: { connectAttempted: 2, connectSucceeded: 1 },
      },
    });
    const own = metrics.ownAgents.data.daily;
    expect(corePoint(own, '2026-10-21')).toMatchObject({
      connectAttempted: 1, connectSucceeded: 1,
      byRoute: { code: { connectAttempted: 1, connectSucceeded: 1 }, connector: { connectAttempted: 0, connectSucceeded: 0 } },
    });
    expect(corePoint(own, '2026-10-24')).toMatchObject({
      connectAttempted: 1, connectSucceeded: 0,
      byRoute: { code: { connectAttempted: 0, connectSucceeded: 0 }, connector: { connectAttempted: 1, connectSucceeded: 1 } },
    });
    // Connector joins were always recorded, so that route has no unknown days.
    expect(corePoint(own, '2026-09-15')).toMatchObject({
      connectAttempted: null,
      byRoute: { code: { connectAttempted: null }, connector: { connectAttempted: 0 } },
    });
  }, 30_000);


  it('leaves one failed core metric unavailable and keeps the others', async () => {
    const original = rootFixture.db.query.bind(rootFixture.db);
    vi.spyOn(rootFixture.db, 'query').mockImplementation((sql, values) => {
      if (String(sql).includes('core-metric:invites')) return Promise.reject(new Error(secret));
      return original(sql, values);
    });
    const metrics = await dashboardCoreMetrics(rootFixture.db, ['ios'], coreMeasuredAt);
    expect(metrics.invites).toEqual({ state: 'unavailable', measuredAt: null });
    expect(metrics.tokens.state).toBe('measured');
    expect(metrics.onboarding.state).toBe('measured');
    expect(JSON.stringify(metrics)).not.toContain(secret);
  });


  it.each([
    '2026-11-11T00:00:00.000Z', // UTC midnight, still November 10 in Eastern.
    '2026-11-11T04:59:00.000Z', // Eastern 23:59.
    '2026-11-11T05:00:00.000Z', // Eastern midnight.
    '2026-11-11T05:06:00.000Z', // Eastern 00:06, the release failure time.
  ])('shows today on GET /v1/admin/dashboard and leaves yesterday unknown at %s', async (measuredAt) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(measuredAt));
    // The migrated snapshot can predate Eastern midnight. This scenario starts
    // invite measurement today, independently of when the suite built its template.
    await rootFixture.db.query(
      `UPDATE operator_metric_epochs SET started_at=$1 WHERE metric='invite'`,
      [measuredAt],
    );
    const human = '1'.repeat(64);
    const internal = '2'.repeat(64);
    const forgotten = '3'.repeat(64);
    await rootFixture.db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Person'),($2,'human','Internal'),($3,'human','Forgotten')`,
      [human, internal, forgotten],
    );
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'member')`,
      [workspace, human, forgotten],
    );
    await rootFixture.db.query(`INSERT INTO workspaces(id,name,internal) VALUES($1,'Internal',true)`, [coreWorkspace]);
    await rootFixture.db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
      [coreWorkspace, internal],
    );
    await rootFixture.db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('core-http-1',$1,'ios','physical'),('core-http-2',$2,'ios','physical'),('core-http-3',$3,'ios','physical')`,
      [human, internal, forgotten],
    );
    await rootFixture.db.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,created_at)
       VALUES('core-http-live',$1,$2,$3::timestamptz + interval '1 day',$3)`,
      [workspace, human, measuredAt],
    );
    await rootFixture.db.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,created_at)
       VALUES('core-http-null',$1,$2,$3::timestamptz + interval '1 day',NULL)`,
      [workspace, forgotten, measuredAt],
    );
    await rootFixture.db.query(
      `INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,created_at)
       VALUES('core-http-internal',$1,$2,$3::timestamptz + interval '1 day',$3)`,
      [coreWorkspace, internal, measuredAt],
    );
    const response = await get('?platforms=ios');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.schemaVersion).toBe(1);
    const invites = payload.coreMetrics.invites;
    expect(invites.state).toBe('measured');
    expect(invites.measuredAt).toBe(measuredAt);
    expect(invites.data.since).toBe(measuredAt);
    expect(invites.data.timeZone).toBe('America/New_York');
    expect(payload.coreMetrics.onboarding.state).toBe('measured');
    expect(payload.coreMetrics.ownAgents.state).toBe('measured');
    expect(payload.coreMetrics.repositories.state).toBe('measured');
    expect(payload.coreMetrics.tokens.state).toBe('measured');
    expect(invites.data.daily).toHaveLength(90);
    const today = easternDay();
    const todayPoint = corePoint(invites.data.daily, today);
    expect(todayPoint.inviters).toBe(1);
    expect(todayPoint.invitesAccepted).toBe(0);
    expect(corePoint(invites.data.daily, shiftEasternDay(today, -1)).inviters).toBeNull();
    expect(invites.data.prior7.inviters).toBeNull();
    expect(invites.data.last7.inviters).toBe(1);
    const body = JSON.stringify(payload);
    expect(body).not.toContain(human);
    expect(body).not.toContain(internal);
    expect(body).not.toContain(forgotten);
    expect(body).not.toContain(secret);
  }, 30_000);


  it('keeps the invite epoch day measured when a dashboard read crosses Eastern midnight', async () => {
    const startedAt = '2026-11-11T04:59:00.000Z'; // November 10 at 23:59 Eastern.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T05:06:00.000Z'));
    await rootFixture.db.query(
      `UPDATE operator_metric_epochs SET started_at=$1 WHERE metric='invite'`,
      [startedAt],
    );
    const response = await get('?platforms=ios');
    expect(response.status).toBe(200);
    const { coreMetrics: { invites } } = await response.json();
    expect(invites.state).toBe('measured');
    expect(invites.data.since).toBe(startedAt);
    expect(corePoint(invites.data.daily, '2026-11-09').inviters).toBeNull();
    expect(corePoint(invites.data.daily, '2026-11-10').inviters).toBe(0);
    expect(corePoint(invites.data.daily, '2026-11-11').inviters).toBe(0);
  });


  it('Reproduction CORE-OWN-WEEK: an unmeasured own-agent week stays null on the dashboard', async () => {
    const human = 41;
    const agent = 42;
    const internal = 43;
    const internalAgent = 44;
    const today = easternDay();
    const priorDay = shiftEasternDay(today, -10);
    const measuredPriorDay = shiftEasternDay(today, -8);
    const quietDay = shiftEasternDay(today, -1);
    await rootFixture.db.query(`INSERT INTO workspaces(id,name,internal) VALUES($1,'Internal',true)`, [coreWorkspace]);
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Internal')`, [coreRoom, coreWorkspace]);
    await scope3.person(human, 'ios');
    await scope3.ownAgent(agent, human);
    await scope3.person(internal, 'ios', undefined, coreWorkspace);
    await scope3.ownAgent(internalAgent, internal);
    const turn = (requestId: string, agentId: number, roomId: string, at: string, input: number | null, output: number | null) =>
      rootFixture.db.query(
        `INSERT INTO agent_turns(room_id,request_id,agent_id,status,created_at,input_tokens,output_tokens)
         VALUES($1,$2,$3,'complete',$4,$5,$6)`,
        [roomId, requestId, coreId(agentId), at, input, output],
      );
    await turn('week-today', agent, room, coreAt(today), null, null);
    await turn('week-prior', agent, room, coreAt(priorDay), null, null);
    await turn('week-internal', internalAgent, coreRoom, coreAt(today), 9999, 1);

    const readTokens = async () => {
      const response = await get('?platforms=ios');
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.coreMetrics.tokens.state).toBe('measured');
      const body = JSON.stringify(payload);
      expect(body).not.toContain(coreId(human));
      expect(body).not.toContain(coreId(internal));
      return payload.coreMetrics.tokens.data;
    };

    const unmeasured = await readTokens();
    expect(corePoint(unmeasured.daily, today)).toMatchObject({
      ownAgentTokens: null, ownAgentTurnsUnmeasured: 1, freeAgentTokens: 0,
    });
    expect(corePoint(unmeasured.daily, priorDay)).toMatchObject({
      ownAgentTokens: null, ownAgentTurnsUnmeasured: 1,
    });
    expect(corePoint(unmeasured.daily, quietDay)).toMatchObject({
      ownAgentTokens: 0, ownAgentTurnsUnmeasured: 0,
    });
    expect(unmeasured.last7).toMatchObject({ ownAgentTokens: null, ownAgentTurnsUnmeasured: 1 });
    expect(unmeasured.prior7).toMatchObject({ ownAgentTokens: null, ownAgentTurnsUnmeasured: 1 });
    expect(unmeasured.change.ownAgentTokens).toEqual({ dayOverDay: null, weekOverWeek: null });

    await turn('week-prior-measured', agent, room, coreAt(measuredPriorDay), 80, 20);
    const mixedPrior = await readTokens();
    expect(mixedPrior.last7.ownAgentTokens).toBeNull();
    expect(mixedPrior.prior7).toMatchObject({ ownAgentTokens: 100, ownAgentTurnsUnmeasured: 1 });
    expect(mixedPrior.change.ownAgentTokens.weekOverWeek).toBeNull();

    await turn('week-zero', agent, room, coreAt(today), 0, 0);
    const measuredZero = await readTokens();
    expect(corePoint(measuredZero.daily, today)).toMatchObject({
      ownAgentTokens: 0, ownAgentTurnsUnmeasured: 1,
    });
    expect(measuredZero.last7).toMatchObject({ ownAgentTokens: 0, ownAgentTurnsUnmeasured: 1 });
    expect(measuredZero.prior7.ownAgentTokens).toBe(100);
    expect(measuredZero.change.ownAgentTokens.weekOverWeek).toBe(-1);
  }, 60_000);
});

it('reconciles signup counts and return eligibility from one production cohort and timestamp', async () => {
  const { dashboardPeriods } = await import('./operator-dashboard-periods.js');
  const measuredAt = '2026-11-08T15:11:00Z';
  await rootFixture.db.query(`UPDATE workspaces SET allow_fix_sweep=false WHERE id=$1`, [workspace]);
  for (const [index, created] of [
    '2026-11-07T15:44:25Z', '2026-11-08T02:10:24Z',
    '2026-10-30T15:00:00Z', '2026-10-29T15:00:00Z',
  ].entries()) {
    const human = `a${index.toString(16).padStart(63, '0')}`, agent = `b${index.toString(16).padStart(63, '0')}`;
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name,created_at)
      VALUES($1,'human','Customer',$3),($2,'agent','Helper',$3)`, [human, agent, created]);
    await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,identity_id,role,joined_at)
      VALUES($1,$2,'owner',$3)`, [workspace, human, created]);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES($1,$3,$4,'hello',$6::timestamptz+interval '1 minute'),
        ($2,$3,$5,'reply',$6::timestamptz+interval '2 minutes')`,
    [`reconcile-first-${index}`, `reconcile-reply-${index}`, room, human, agent, created]);
    if (index === 2) {
      for (const days of [1, 7]) await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
        VALUES($1,$2,$3,'back',$4::timestamptz+$5::int*interval '24 hours')`,
      [`reconcile-return-${days}`, room, human, created, days]);
    }
  }
  const periods = await dashboardPeriods(rootFixture.db, measuredAt);
  for (const period of Object.values(periods)) {
    expect(period.growth.newPeople).toBe(period.funnel.steps[0]!.count);
    expect((period.growth.series as {value: number}[]).reduce((sum, p) => sum + p.value, 0))
      .toBe(period.growth.newPeople);
  }
  expect(periods['24h']!.funnel.steps.slice(0, 4).map(s => s.count)).toEqual([2, 2, 2, 2]);
  expect(periods['24h']!.funnel.returns.map(s => [s.eligible, s.count])).toEqual([[0, null], [0, null]]);
  expect(periods['28d']!.funnel.returns.map(s => [s.eligible, s.count])).toEqual([[2, 1], [1, 1]]);
});
