import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = readFileSync(new URL('./release-steps/server-leg.sh', import.meta.url), 'utf8');
const rollout = script.match(/(?:deploy_machine|retry_flyctl_update)\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(rollout);

for (const ready of [true, false]) test(`server replacement ${ready ? 'passes' : 'fails'} readiness before old traffic stops`, () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-ready-rollout-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'server-release'));
    const state = join(root, 'state.json');
    const image = 'registry.fly.io/beeline-server:new';
    const oldImage = 'registry.fly.io/beeline-server:old';
    writeFileSync(state, JSON.stringify({ ready, events: [], machines: [
      { id: 'old-one', state: 'started', config: { image: oldImage } },
      { id: 'old-two', state: 'started', config: { image: oldImage } },
    ] }));
    writeFileSync(join(root, 'bin/flyctl'), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
let status = 0;
if (args[0] === 'deploy') {
  if (value('--strategy') !== 'bluegreen' || !args.includes('--config') || !args.includes('--only-machines')) process.exit(9);
  const old = value('--only-machines');
  state.events.push('start:new-one', 'readyz:new-one:' + state.ready);
  if (state.ready) {
    state.events.push('traffic:new-one', 'stop:' + old);
    state.machines = state.machines.filter(m => m.id !== old);
    state.machines.push({ id: 'new-one', state: 'started', config: { image: value('--image') } });
  } else status = 1;
} else if (args[0] === 'machine' && args[1] === 'update') {
  state.events.push('stop:' + args[2], 'start:' + args[2]);
} else if (args[0] === 'machine' && args[1] === 'list') {
  console.log(JSON.stringify(state.machines));
} else process.exit(8);
fs.writeFileSync(process.env.STATE, JSON.stringify(state));
process.exit(status);
`, { mode: 0o755 });
    const name = rollout.slice(0, rollout.indexOf('('));
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${rollout}\ncanary=old-one\nsecond=old-two\n${name} "$canary" "$IMAGE" canary "$OLD_IMAGE"\nprintf '%s' "$canary"`], {
      encoding: 'utf8', cwd: root,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, STATE: state,
        RUNNER_TEMP: root, IMAGE: image, OLD_IMAGE: oldImage },
    });
    const after = JSON.parse(readFileSync(state, 'utf8'));
    if (ready) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(after.events, ['start:new-one', 'readyz:new-one:true', 'traffic:new-one', 'stop:old-one']);
      assert.ok(result.stdout.endsWith('new-one'), 'canary probes must follow the replacement ID');
      assert.deepEqual(after.machines.map(m => m.id).sort(), ['new-one', 'old-two']);
    } else {
      assert.notEqual(result.status, 0);
      assert.deepEqual(after.events, ['start:new-one', 'readyz:new-one:false']);
      assert.deepEqual(after.machines.map(m => m.id), ['old-one', 'old-two']);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Fly deployment check gates routing on /readyz', () => {
  const config = readFileSync(new URL('../../apps/infra/fly.beeline-server.toml', import.meta.url), 'utf8');
  assert.match(config, /\[deploy\]\s+strategy = "bluegreen"/);
  assert.match(config, /\[\[http_service.checks\]\][\s\S]*path = "\/readyz"/);
  assert.match(config, /\[processes\]\s+(?:#.*\n\s*)?app = ""/);
});

test('replacement configuration retains the serving fleet’s resources and runtime settings', () => {
  const config = readFileSync(new URL('../../apps/infra/fly.beeline-server.toml', import.meta.url), 'utf8');
  assert.match(config, /\[\[vm\]\]\s+cpu_kind = "performance"\s+cpus = 1\s+memory = "2048mb"/);
  assert.match(config, /DATABASE_POOL_MAX = "25"/);
  assert.match(config, /NODE_OPTIONS = ""/);
  assert.match(config, /BEELINE_GOOGLE_SIGN_IN_SUBJECTS = "[^"]+"/);
  assert.doesNotMatch(config, /BEELINE_SERVER_MACHINES\s*=/);
  assert.match(config, /^kill_signal = "SIGTERM"$/m);
  assert.match(config, /^kill_timeout = "300s"$/m);
  assert.match(config, /\[\[restart\]\]\s+policy = "on-failure"\s+retries = 10/);
});
