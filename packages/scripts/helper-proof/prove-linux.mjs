import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink, cp, rename, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedNativeProof } from '../../../apps/body/src/lifecycle-test-guard.ts';
import { observeHelper } from './observe-helper.mjs';
import { helperServiceUnit } from '../../../apps/body/src/native-helper.ts';

if (!isolatedNativeProof(process.env))
  throw new Error('native lifecycle proof refuses a shared manager or install');
const fixture = await import('./fixture.mjs');
const { origin, agents, database, auth, stateRoot } = fixture;
const exec = promisify(execFile);
const evidence = [];
const env = {
  ...process.env,
  BEELINE_UPDATE_MANIFEST_URL: `${origin}/dl/manifest.json`,
  BEELINE_MONOLITH_BASE_URL: origin,
};
const cli = '/home/proof/.local/bin/beeline';
const unit = '/home/proof/.config/systemd/user/beeline-helper.service';
const systemctl = async (...args) =>
  (await exec('systemctl', ['--user', ...args], { env, timeout: 120_000 })).stdout;
let lastObservation;
const observe = (accept = () => true, timeout = 90_000) =>
  observeHelper(stateRoot, accept, timeout, (status) => {
    const observed = JSON.stringify({
      generation: status.generation,
      pid: status.pid,
      processState: status.processState,
      loadedRelease: status.loadedRelease,
      desiredRelease: status.desiredRelease,
    });
    if (observed !== lastObservation) {
      lastObservation = observed;
      console.log(`[native-status] ${observed}`);
    }
  });
const serving = (status) =>
  status.processState === 'serving' && agents.every((id) => status.agents[id]?.state === 'serving');
async function entry(command, args = [], options = {}) {
  const result = await exec(command, args, {
    env,
    timeout: 600_000,
    maxBuffer: 1_000_000,
    ...options,
  });
  return result.stdout + result.stderr;
}
async function phase(name, body) {
  if (process.env.BEELINE_PROOF_PHASES && !new RegExp(process.env.BEELINE_PROOF_PHASES).test(name))
    return;
  const began = Date.now();
  console.log(`[native-proof] ${name}`);
  await body();
  evidence.push({ name, passed: true, elapsedMs: Date.now() - began });
  console.log(`[native-proof] passed ${name}`);
}
async function publish(version, commit, fault = '') {
  await fixture.makeRelease(version, commit, fault);
  if (!fault)
    await fixture.releases.notifyReleaseDelivered({
      version,
      sha: commit,
      changelogUrl: `${origin}/changes`,
    });
}
let baseline;
try {
  await systemctl(
    'set-environment',
    ...Object.entries(env)
      .filter(([name]) => /^(?:HOME|XDG_|DBUS_|BEELINE_)/.test(name))
      .map(([name, value]) => `${name}=${value}`),
  );
  await phase(
    'real shell installer, native service, legacy signed identity migration',
    async () => {
      const prior = JSON.parse(
        await readFile(`${stateRoot}/beeline/agents/${agents[1]}/runtime.json`, 'utf8'),
      );
      fixture.loseLegacyExchangeReply();
      console.log(
        await entry('/bin/sh', ['/workspace/apps/site/install.sh'], {
          env: { ...env, BEELINE_INSTALL_BASE_URL: origin },
        }),
      );
      baseline = await observe(serving);
      const migrated = JSON.parse(
        await readFile(`${stateRoot}/beeline/agents/${agents[1]}/runtime.json`, 'utf8'),
      );
      for (const key of ['agent', 'body', 'accessPolicy', 'pairedBy', 'supervisorRoot'])
        assert.deepEqual(migrated[key], prior[key]);
      assert.equal(migrated.transport.kind, 'monolith');
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM legacy_daemon_migrations'))
          .rows[0].count,
        1,
      );
      assert.match(
        await systemctl(
          'show',
          '-p',
          'ActiveState',
          '-p',
          'UnitFileState',
          '-p',
          'MainPID',
          'beeline-helper.service',
        ),
        /ActiveState=active/,
      );
    },
  );
  await phase('npx current-release update repairs an exit-79 dead helper', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      unit,
      '[Unit]\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=/bin/sh -c "exit 79"\nRestart=always\nRestartPreventExitStatus=79\n[Install]\nWantedBy=default.target\n',
    );
    await systemctl('daemon-reload');
    await systemctl('start', 'beeline-helper.service');
    await delay(300);
    assert.match(
      await systemctl(
        'show',
        '-p',
        'ActiveState',
        '-p',
        'ExecMainStatus',
        'beeline-helper.service',
      ),
      /ExecMainStatus=79/,
    );
    console.log(
      await entry('npx', [
        '--offline',
        '--yes',
        '--package',
        '/workspace/packages/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
        'usebeeline',
        'update',
      ]),
    );
    const repaired = await observe(serving);
    assert.notEqual(repaired.generation, baseline.generation);
    assert.equal(await readFile(unit, 'utf8'), helperServiceUnit());
    baseline = repaired;
    console.log(await entry(cli, ['update']));
    assert.equal((await observe(serving)).generation, repaired.generation);
    for (const [command, args] of [
      [cli, ['update']],
      [
        'npx',
        [
          '--offline',
          '--yes',
          '--package',
          '/workspace/packages/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'start',
        ],
      ],
      [cli, ['start']],
    ]) {
      const previous = (await observe(serving)).generation;
      await systemctl('disable', '--now', 'beeline-helper.service');
      console.log(await entry(command, args));
      baseline = await observe(serving);
      assert.notEqual(baseline.generation, previous);
      assert.match(await systemctl('is-enabled', 'beeline-helper.service'), /enabled/);
    }
  });
  await phase(
    'scoped stop acknowledgment, preserved stop, start, all-stopped live helper',
    async () => {
      console.log(await entry(cli, ['stop', '--agent', agents[0]]));
      let status = await observe((s) => s.agents[agents[0]]?.state === 'stopped');
      assert.equal(status.agents[agents[1]].state, 'serving');
      const generation = status.generation;
      console.log(await entry(cli, ['update']));
      assert.equal((await observe()).agents[agents[0]].state, 'stopped');
      console.log(await entry(cli, ['stop', '--agent', agents[1]]));
      status = await observe((s) => agents.every((id) => s.agents[id]?.state === 'stopped'));
      assert.equal(status.generation, generation);
      assert.equal(status.processState, 'serving');
      console.log(await entry(cli, ['start', '--all']));
      baseline = await observe(serving);
      assert.equal(baseline.generation, generation);
    },
  );
  await phase(
    'old per-agent units, pinned ExecStart, real anchor and broken forwarder converge forward',
    async () => {
      await systemctl('stop', 'beeline-helper.service');
      await writeFile(
        '/home/proof/.config/systemd/user/beeline-agent@.service',
        '[Service]\nType=simple\nExecStart=/bin/sleep infinity\nRestart=always\n[Install]\nWantedBy=default.target\n',
      );
      await writeFile(
        unit,
        helperServiceUnit().replace(
          'ExecStart=%h/.local/bin/beeline helper-bootstrap',
          `ExecStart=/usr/local/bin/node /home/proof/.local/lib/beeline-releases/${baseline.loadedRelease}/lib/beeline/beeline-cli.mjs daemon --machine`,
        ),
      );
      await systemctl('daemon-reload');
      for (const id of agents) await systemctl('enable', '--now', `beeline-agent@${id}.service`);
      const anchor = '/home/proof/.local/lib/beeline';
      await cp(anchor, `${anchor}.fixture-copy`, { recursive: true, dereference: true });
      await unlink(anchor);
      await rename(`${anchor}.fixture-copy`, anchor);
      await writeFile(cli, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      console.log(
        await entry('npx', [
          '--offline',
          '--yes',
          '--package',
          '/workspace/packages/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'update',
        ]),
      );
      baseline = await observe(serving);
      assert.match(await readlink(anchor), /^beeline-releases\//);
      assert.equal(await readFile(unit, 'utf8'), helperServiceUnit());
      for (const id of agents)
        assert.match(
          await systemctl(
            'show',
            '-p',
            'ActiveState',
            '-p',
            'MainPID',
            `beeline-agent@${id}.service`,
          ),
          /MainPID=0/,
        );
      await writeFile(cli, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const generation = baseline.generation;
      console.log(
        await entry('npx', [
          '--offline',
          '--yes',
          '--package',
          '/workspace/packages/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
          'usebeeline',
          'update',
        ]),
      );
      assert.equal((await observe(serving)).generation, generation);
      assert.match(await entry(cli, ['--version']), /v0.2.0/);
    },
  );
  await phase('a legacy per-agent entry hands its own native unit to the sole helper', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      '/home/proof/.config/systemd/user/beeline-agent@.service',
      '[Service]\nType=simple\nEnvironment=BEELINE_MANAGED_BY_SYSTEMD=1\nExecStart=%h/.local/bin/beeline daemon --agent %i\nRestart=always\n[Install]\nWantedBy=default.target\n',
    );
    await systemctl('daemon-reload');
    await systemctl('enable', '--now', `beeline-agent@${agents[0]}.service`);
    baseline = await observe(serving);
    assert.match(
      await systemctl(
        'show',
        '-p',
        'ActiveState',
        '-p',
        'MainPID',
        `beeline-agent@${agents[0]}.service`,
      ),
      /MainPID=0/,
    );
    console.log(await entry(cli, ['update']));
  });
  await phase('kernel process death restarts the sole owner', async () => {
    const successor = observe((s) => serving(s) && s.generation !== baseline.generation);
    await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', 'beeline-helper.service');
    baseline = await successor;
  });
  await phase(
    'real command intake and reply through the fixture HTTP/WebSocket server',
    async () => {
      await fixture.addRoom();
      const id = await fixture.message('native first message');
      const replies = await fixture.waitReply(id, 60_000);
      assert.equal(replies.length, 1);
      console.log('[native-command]', JSON.stringify({ request: id, replies }));
      const scopes = await systemctl(
        'list-units',
        '--type=scope',
        '--all',
        '--plain',
        '--no-legend',
        'beeline-acp-*',
      );
      assert.match(scopes, /beeline-acp-.*active/);
      console.log('[native-acp-scopes]', scopes);
    },
  );
  await phase('invalid release checksum, import, and engine fail without activation', async () => {
    const generation = (await observe(serving)).generation;
    for (const fault of ['checksum', 'import', 'engine']) {
      await fixture.makeRelease('v0.2.1', '2'.repeat(40), fault);
      await assert.rejects(entry(cli, ['update']), /checksum|import|engine|Node|failed/i);
      assert.equal((await observe(serving)).generation, generation);
    }
    await fixture.makeRelease('v0.2.0', '1'.repeat(40));
  });
  await phase(
    'publication failure recovers verified serving code and reports freshness uncertainty',
    async () => {
      const previous = baseline.generation;
      fixture.setPublicationAvailable(false);
      await systemctl('stop', 'beeline-helper.service');
      try {
        await assert.rejects(entry(cli, ['update']), /freshness unconfirmed/);
        baseline = await observe(serving);
        assert.notEqual(baseline.generation, previous);
        // The status JSON is stdout; progress lines go to stderr.
        const status = JSON.parse(
          (await exec(cli, ['update', '--status'], { env, maxBuffer: 1_000_000 })).stdout,
        );
        assert.equal(status.releaseSelection.lastCheckResult, 'unconfirmed');
      } finally {
        fixture.setPublicationAvailable(true);
      }
      console.log(await entry(cli, ['update']));
    },
  );
  await phase('killed preparation child releases its kernel-owned lock', async () => {
    await fixture.makeRelease('v0.2.1', '2'.repeat(40));
    fixture.holdDownload(true);
    const download = fixture.nextDownload();
    const child = spawn(cli, ['update'], { env, stdio: 'ignore' });
    const exit = new Promise((done) => child.once('exit', done));
    await download;
    child.kill('SIGKILL');
    await exit;
    fixture.holdDownload(false);
    console.log(await entry(cli, ['update']));
    baseline = await observe(serving);
    assert.equal(baseline.loadedIdentity.version, 'v0.2.1');
  });
  await phase('busy update keeps intake open and hands over when quiet', async () => {
    fixture.holdWork(true);
    const started = fixture.nextHarness();
    const heldId = await fixture.message('native-held quiet-gap');
    await started;
    await publish('v0.2.2', '3'.repeat(40));
    await observe((s) => s.desiredRelease && s.desiredRelease !== s.loadedRelease);
    const during = await fixture.message('native mid-drain sibling', 1);
    assert.equal((await fixture.waitReply(during, 60_000)).length, 1);
    const successor = observe((s) => serving(s) && s.generation !== baseline.generation, 120_000);
    fixture.holdWork(false);
    assert.equal((await fixture.waitReply(heldId, 60_000)).length, 1);
    baseline = await successor;
    assert.equal(baseline.loadedIdentity.version, 'v0.2.2');
  });
  await phase(
    "update joins the helper's own preparation and hands off without draining active work",
    async () => {
      fixture.holdWork(true);
      const started = fixture.nextHarness();
      const heldId = await fixture.message('native-held handoff-gap');
      await started;
      // The helper starts preparing the release the moment it is published.
      fixture.holdDownload(true);
      const download = fixture.nextDownload();
      await publish('v0.2.3', '4'.repeat(40));
      await download;
      const child = spawn(cli, ['update'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const joined = new Promise((done) => {
        const read = (chunk) => {
          output += chunk;
          if (output.includes('already running as pid')) done();
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
      });
      const exit = new Promise((done) => child.once('exit', done));
      await Promise.race([joined, exit]);
      assert.match(output, /release preparation already running as pid \d+ .*; following it/);
      fixture.holdDownload(false);
      assert.equal(await exit, 0, output);
      assert.match(output, /executing release/);
      const handedOff = await observe(
        (s) => serving(s) && s.generation !== baseline.generation,
        120_000,
      );
      assert.equal(handedOff.loadedIdentity.version, 'v0.2.3');
      // Held work lives on the server: the successor serves wakes while it is held.
      const during = await fixture.message('native handoff sibling', 1);
      assert.equal((await fixture.waitReply(during, 60_000)).length, 1);
      await publish('v0.2.4', '5'.repeat(40));
      baseline = await observe(
        (s) => serving(s) && s.loadedIdentity?.version === 'v0.2.4',
        120_000,
      );
      const queued = await fixture.message('native newer-target sibling', 1);
      assert.equal((await fixture.waitReply(queued, 90_000)).length, 1);
      fixture.holdWork(false);
      assert.equal((await fixture.waitReply(heldId, 90_000)).length, 1);
    },
  );
  await phase(
    'unrecognized identity and malformed configuration are reported by name while siblings serve',
    async () => {
      // Update reports each agent as the helper answered; one that cannot serve is not a wall.
      const unknown = await fixture.addUnrecognizedAgent();
      console.log(await entry(cli, ['update']));
      let status = await observe((s) => s.agents[unknown]?.state === 'needs-auth');
      assert.ok(serving(status));
      const path = `${stateRoot}/beeline/agents/${unknown}/runtime.json`;
      await writeFile(path, '{broken');
      status = await observe((s) => s.agents[unknown]?.state === 'needs-config');
      assert.ok(serving(status));
      assert.match(await entry(cli, ['update']), new RegExp(`agent ${unknown}: `));
      status = await observe((s) => s.agents[unknown]?.state === 'needs-config');
      assert.ok(serving(status));
      await unlink(path);
      console.log(await entry(cli, ['update']));
    },
  );
  await phase(
    'revoked sign-in remains visible, and a runtime revision recovers only that agent',
    async () => {
      const path = `${stateRoot}/beeline/agents/${agents[0]}/runtime.json`;
      const runtime = JSON.parse(await readFile(path, 'utf8'));
      await database.query('UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1', [
        agents[0],
      ]);
      await delay(10_100); // Let the real authentication cache expire once.
      // Registration authenticates the token: the helper's next registration is refused.
      const prior = (await observe()).generation;
      const restarted = observe(
        (s) =>
          s.generation !== prior &&
          s.agents[agents[0]]?.state === 'needs-auth' &&
          s.agents[agents[1]]?.state === 'serving',
        60_000,
      );
      await systemctl('kill', '--signal=SIGKILL', '--kill-whom=main', 'beeline-helper.service');
      const refused = await restarted;
      const request = await fixture.message('native auth refusal');
      assert.match(await entry(cli, ['update']), new RegExp(`agent ${agents[0]}: `));
      await observe((s) => s.agents[agents[0]]?.state === 'needs-auth', 30_000);
      const exchange = await auth.createDaemonExchange(agents[0]);
      const replacement = await auth.exchangeDaemonToken(exchange.exchangeToken);
      runtime.transport.daemonToken = replacement.daemonToken;
      delete runtime.transport.exchangeToken;
      await writeFile(path, JSON.stringify(runtime));
      baseline = await observe(serving);
      assert.equal(baseline.generation, refused.generation);
      assert.equal((await fixture.waitReply(request, 60_000)).length, 1);
      const sibling = await fixture.message('native sibling after auth refusal', 1);
      assert.equal((await fixture.waitReply(sibling, 60_000)).length, 1);
    },
  );
  await phase('independent npx recovery repairs a body that cannot import', async () => {
    await systemctl('stop', 'beeline-helper.service');
    await writeFile(
      `/home/proof/.local/lib/beeline-releases/${baseline.loadedRelease}/lib/beeline/beeline-cli.mjs`,
      "throw new Error('damaged installed body');\n",
    );
    console.log(
      await entry('npx', [
        '--offline',
        '--yes',
        '--package',
        '/workspace/packages/scripts/helper-proof/artifacts/usebeeline-0.0.6.tgz',
        'usebeeline',
        'update',
        '--force',
      ]),
    );
    baseline = await observe(serving);
    assert.match(baseline.loadedRelease, /repair/);
    assert.equal(baseline.loadedIdentity.version, 'v0.2.4');
  });
  await phase(
    'actual idle machine has no release, discovery, command or status HTTP reads',
    async () => {
      await delay(1000);
      const before = fixture.evidence().calls;
      await delay(30_000);
      const after = fixture.evidence().calls;
      for (const path of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (/manifest|Bootstrap|getAgentConfiguration|getAgentCommands|getRoomInbox/.test(path))
          assert.equal(after[path] || 0, before[path] || 0, path);
      assert.equal((await observe(serving)).generation, baseline.generation);
    },
  );
  await phase('explicit native stop stays off', async () => {
    await systemctl('stop', 'beeline-helper.service');
    const scopes = await systemctl(
      'list-units',
      '--type=scope',
      '--state=active',
      '--plain',
      '--no-legend',
      'beeline-acp-*',
    );
    assert.equal(scopes.trim(), '', 'native stop must end every ACP scope');
    console.log('[native-acp-scopes] no active scopes after native stop');
    await delay(6500);
    assert.match(
      await systemctl('show', '-p', 'ActiveState', '-p', 'MainPID', 'beeline-helper.service'),
      /MainPID=0/,
    );
  });
  console.log(
    JSON.stringify(
      {
        platform: 'Linux systemd user@1001 in disposable Docker PID namespace',
        evidence,
        fixture: fixture.evidence(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  console.error(JSON.stringify(fixture.evidence()));
  console.error(
    (await exec('ps', ['-u', String(process.getuid()), '-o', 'pid,ppid,stat,args'], { env }))
      .stdout,
  );
  console.error(
    await systemctl('status', '--no-pager', 'beeline-helper.service').catch(
      (e) => e.stdout + e.stderr,
    ),
  );
  console.error(
    (
      await exec(
        'journalctl',
        ['--user', '-u', 'beeline-helper.service', '--no-pager', '-n', '100'],
        { env },
      ).catch((e) => e)
    ).stdout,
  );
  process.exitCode = 1;
} finally {
  await systemctl('stop', 'beeline-helper.service').catch(() => {});
  await fixture.closeFixture();
}
