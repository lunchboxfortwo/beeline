import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, watch } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { isolatedNativeProof } from '../../apps/body/src/lifecycle-test-guard.ts';
import { privateSocketPath } from '../../apps/body/src/local-socket.ts';
import { requestMachine } from '../../apps/body/src/machine-control.ts';
import { convergeNativeHelper } from '../../apps/body/src/native-helper.ts';

if (!isolatedNativeProof(process.env))
  throw new Error('update handoff proof requires the disposable native-proof container');
const fixture = await import('./fixture.mjs');
const { origin, agents, stateRoot } = fixture;
const exec = promisify(execFile);
const env = {
  ...process.env,
  BEELINE_UPDATE_MANIFEST_URL: `${origin}/dl/manifest.json`,
  BEELINE_MONOLITH_BASE_URL: origin,
};
const systemctl = async (...args) =>
  (await exec('systemctl', ['--user', ...args], { env, timeout: 120_000 })).stdout;
const serving = (s) =>
  s.processState === 'serving' && agents.every((id) => s.agents[id]?.state === 'serving');
// Proof deadlines fail the test; the helper has no handoff timer or watchdog.
async function within(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native update handoff proof timed out')),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const observe = (accept) => within(requestMachine(stateRoot, { operation: 'status' }, accept));
const statePath = '/home/proof/.local/lib/beeline-releases/.state/update-state.json';
async function failedPreparation(announce) {
  const controller = new AbortController();
  const watcher = watch('/home/proof/.local/lib/beeline-releases/.state', {
    signal: controller.signal,
  });
  const changed = async () => {
    for await (const event of watcher) {
      if (event.filename !== 'update-state.json') continue;
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (
        state.lastCheckResult === 'unconfirmed' &&
        /startup smoke test/.test(state.lastCheckError ?? '')
      )
        return state;
    }
    throw new Error('update state watcher ended before a failed startup proof');
  };
  try {
    const result = changed();
    await announce();
    return await within(result);
  } finally {
    controller.abort();
  }
}
const announce = (version, sha) =>
  fixture.releases.notifyReleaseDelivered({ version, sha, changelogUrl: `${origin}/changes` });
async function replyFromEveryAgent(label) {
  for (let index = 0; index < agents.length; index++) {
    const id = await fixture.message(`${label} ${index}`, index);
    assert.equal((await within(fixture.waitReply(id, 60_000))).length, 1);
  }
}
let retained;
try {
  await systemctl(
    'set-environment',
    ...Object.entries(env)
      .filter(([key]) => /^(?:HOME|XDG_|DBUS_|BEELINE_)/.test(key))
      .map(([key, value]) => `${key}=${value}`),
  );
  await mkdir('/home/proof/.config/systemd/user/beeline-helper.service.d', { recursive: true });
  await writeFile(
    '/home/proof/.config/systemd/user/beeline-helper.service.d/proof.conf',
    '[Service]\nWatchdogSec=0\n',
  );
  await exec('/bin/sh', ['/workspace/web/install.sh'], {
    env: { ...env, BEELINE_LAB: '1', BEELINE_INSTALL_BASE_URL: origin },
    timeout: 120_000,
  });
  await convergeNativeHelper({ env });
  await observe(serving);
  await fixture.addRoom();
  await replyFromEveryAgent('before idle update');
  const before = await observe(serving);
  // Reproduce an idle harness/client retaining a private broker connection.
  // server.close cannot finish until this peer closes. Leave it open across
  // the entire handoff: the exiting helper must not wait for it.
  retained = createConnection(
    privateSocketPath(JSON.stringify(['registry-mcp', '/home/proof', before.pid, agents[0]])),
  );
  await once(retained, 'connect');
  await fixture.makeRelease('v0.2.1', '2'.repeat(40));
  await announce('v0.2.1', '2'.repeat(40));
  const after = await observe((s) => serving(s) && s.generation !== before.generation);
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.loadedIdentity.version, 'v0.2.1');
  assert.equal(after.loadedRelease, '2'.repeat(40));
  assert.match(
    await systemctl('show', '-p', 'WatchdogUSec', '-p', 'Restart', 'beeline-helper.service'),
    /WatchdogUSec=0/,
  );
  await replyFromEveryAgent('after idle update');
  console.log(
    'PASS: verified idle handoff replaces the PID and both agents answer with WatchdogSec=0 and a retained broker client',
  );

  // The archive has a valid checksum and identity, but the new CLI fails its
  // startup proof. Preparation must leave the old process and connection live.
  await fixture.makeRelease('v0.2.2', '3'.repeat(40), 'import');
  await failedPreparation(() => announce('v0.2.2', '3'.repeat(40)));
  const failed = await observe(serving);
  assert.equal(failed.generation, after.generation);
  assert.equal(failed.pid, after.pid);
  assert.equal(failed.loadedRelease, after.loadedRelease);
  await replyFromEveryAgent('after failed successor proof');
  console.log(
    'PASS: failed successor startup proof preserves the serving PID, release and both agent connections',
  );
} catch (error) {
  console.error(error);
  console.error(
    await systemctl(
      'show',
      '-p',
      'MainPID',
      '-p',
      'StatusText',
      '-p',
      'ActiveState',
      'beeline-helper.service',
    ),
  );
  console.error(
    (
      await exec(
        'journalctl',
        ['--user', '-u', 'beeline-helper.service', '--no-pager', '-n', '80'],
        { env },
      )
    ).stdout,
  );
  process.exitCode = 1;
} finally {
  retained?.destroy();
  await systemctl('stop', 'beeline-helper.service').catch(() => {});
  await fixture.closeFixture();
  process.exit(process.exitCode ?? 0);
}
