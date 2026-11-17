import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDrained, schemaProblems, sourceTrees } from './rollout-schema.mjs';

const release = { version: 'v0.1.200', sourceSha: 'a'.repeat(40) };
const machines = [
  { id: 'first', state: 'started', config: { image: 'registry.fly.io/beeline-server:deployment-AAA' } },
  { id: 'second', state: 'started', config: { image: 'registry.fly.io/beeline-server:deployment-BBB' } },
];
const refused = /contract migration refused/;

function probe(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const id = options.headers['fly-force-instance-id'];
    assert.ok(machines.some(machine => machine.id === id));
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    const path = new URL(url).pathname;
    calls.push(`${id}${path}`);
    const response = overrides[`${id}${path}`];
    if (response instanceof Error) throw response;
    return response ?? Response.json(path === '/version' ? release : { ok: true });
  };
  return { calls, fetchImpl };
}

test('drain accepts different Fly deployment tags serving the exact release on every Machine', async () => {
  const { calls, fetchImpl } = probe();
  await assertDrained(machines, release, fetchImpl);
  assert.deepEqual(calls.sort(), ['first/readyz', 'first/version', 'second/readyz', 'second/version']);
});

test('matching image tags cannot authorize a Machine serving an older source or version', async () => {
  const sameTag = machines.map(machine => ({ ...machine, config: { image: 'registry.fly.io/beeline-server:0.1.200-aaaaaaaaaaaa' } }));
  for (const version of [
    { ...release, sourceSha: 'b'.repeat(40) },
    { ...release, version: 'v0.1.199' },
    { ...release, sourceSha: release.sourceSha.slice(0, 12) },
    {},
    null,
  ]) {
    await assert.rejects(assertDrained(sameTag, release, probe({ 'second/version': Response.json(version) }).fetchImpl), refused);
  }
});

test('drain refuses empty, stopped or unidentified fleets before probing', async () => {
  for (const fleet of [[], [{ ...machines[0], state: 'stopped' }], [{ ...machines[0], id: '' }]]) {
    const { calls, fetchImpl } = probe();
    await assert.rejects(assertDrained(fleet, release, fetchImpl), refused);
    assert.deepEqual(calls, []);
  }
});

test('drain refuses missing release identity before probing', async () => {
  for (const expected of [{}, { version: release.version }, { sourceSha: release.sourceSha }]) {
    const { calls, fetchImpl } = probe();
    await assert.rejects(assertDrained(machines, expected, fetchImpl), refused);
    assert.deepEqual(calls, []);
  }
});

test('drain fails closed on readiness, HTTP, network, timeout or malformed version responses', async () => {
  for (const overrides of [
    { 'second/readyz': new Response('', { status: 503 }) },
    { 'second/version': new Response('', { status: 500 }) },
    { 'second/version': new Error('connection refused') },
    { 'second/version': new DOMException('timed out', 'TimeoutError') },
    { 'second/version': new Response('not json') },
  ]) {
    await assert.rejects(assertDrained(machines, release, probe(overrides).fetchImpl), refused);
  }
});


test('current server has no dependency on the approved retired turn columns', () => {
  const { current } = sourceTrees('HEAD');
  current['apps/server/contracts/retired-turn-probe.sql'] = `
    ALTER TABLE agents DROP COLUMN squire_report;
    ALTER TABLE messages DROP COLUMN event_woken;
  `;
  assert.deepEqual(schemaProblems(current, {}), []);
});

const retiredContract = {
  'apps/server/contracts/retired-turn-probe.sql': `
    ALTER TABLE agents DROP COLUMN squire_report;
    ALTER TABLE messages DROP COLUMN event_woken;
  `,
};

test('unrelated CTE and recordset wildcards do not read retired columns', () => {
  const source = `
    const queue = \`WITH queued AS (SELECT * FROM agent_commands)
      SELECT item.*,agent.owner_id FROM queued item
      LEFT JOIN agents agent ON agent.agent_id=item.agent_id\`;
    const repair = \`WITH repairs AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS r(id text,mime text,title text))
      UPDATE messages m SET attachments=(SELECT jsonb_agg(r.mime) FROM repairs r)
      WHERE m.id=$2\`;
  `;
  for (const revision of ['candidate', 'previous release']) {
    const tree = { 'apps/server/src/probe.ts': source };
    assert.deepEqual(schemaProblems(
      { ...retiredContract, ...(revision === 'candidate' ? tree : {}) },
      revision === 'previous release' ? tree : {},
    ), []);
  }
});

test('real retired-column readers and writers still block candidate and rollback contracts', () => {
  const readers = [
    ['agents.squire_report', 'SELECT * FROM agents'],
    ['agents.squire_report', 'SELECT * FROM ONLY agents'],
    ['agents.squire_report', 'SELECT * FROM ONLY (agents)'],
    ['agents.squire_report', 'SELECT DISTINCT * FROM public."agents"'],
    ['agents.squire_report', 'SELECT DISTINCT ON (agent_id) * FROM agents'],
    ['agents.squire_report', 'SELECT *, 1 AS extra FROM identities JOIN agents ON true'],
    ['agents.squire_report', 'SELECT * FROM (agents a JOIN identities i ON a.agent_id=i.id)'],
    ['agents.squire_report', 'SELECT * FROM (identities i JOIN agents a ON a.agent_id=i.id)'],
    ['agents.squire_report', 'SELECT id, * FROM identities, agents'],
    ['agents.squire_report', 'WITH queued AS (SELECT * FROM agents) SELECT id FROM queued'],
    ['agents.squire_report', 'SELECT * FROM (SELECT * FROM agents) agent'],
    ['agents.squire_report', 'SELECT agent.* FROM agents agent'],
    ['agents.squire_report', 'SELECT agent.squire_report FROM agents agent'],
    ['agents.squire_report', 'SELECT squire_report FROM agents'],
    ['agents.squire_report', 'UPDATE agents SET squire_report=$1'],
    ['messages.event_woken', 'SELECT * FROM messages'],
    ['messages.event_woken', 'WITH repairs AS (SELECT * FROM jsonb_to_recordset($1)) SELECT * FROM messages'],
    ['messages.event_woken', 'INSERT INTO messages(id,event_woken) VALUES($1,$2)'],
  ];
  for (const [column, query] of readers) {
    const tree = { 'apps/server/src/probe.ts': `const query = \`${query}\`;` };
    for (const revision of ['candidate', 'previous release']) {
      assert.deepEqual(schemaProblems(
        { ...retiredContract, ...(revision === 'candidate' ? tree : {}) },
        revision === 'previous release' ? tree : {},
      ), [`${column}: ${revision} still reads or writes it (apps/server/src/probe.ts)`], query);
    }
  }
});
