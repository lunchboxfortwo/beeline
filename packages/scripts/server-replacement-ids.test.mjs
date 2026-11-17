import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./release-steps/server-leg.sh', import.meta.url));

for (const failure of ['none', 'promotion', 'peer-readiness']) test(`replacement IDs reach every later step (${failure})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-replacement-ids-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'server-release'));
    const stateFile = join(root, 'state.json');
    let testedScript = script;
    if (failure === 'peer-readiness') {
      // Inject a terminal readiness verdict after the peer replacement exists;
      // readiness polling itself is covered by the normal execution below.
      testedScript = join(root, 'server-leg.sh');
      writeFileSync(testedScript, readFileSync(script, 'utf8').replace('wait_for_machine_ready() {',
        'wait_for_machine_ready() {\n  if [ "$1" = replacement-old-two ]; then return 1; fi'));
    }
    const previous = 'registry.fly.io/beeline-server:old';
    const image = 'registry.fly.io/beeline-server:new';
    writeFileSync(stateFile, JSON.stringify({ calls: [], machines: ['old-one', 'old-two'].map(id => ({
      id, state: 'started', config: { image: previous },
    })) }));
    writeFileSync(join(root, 'server-release/server-deploy-plan.json'), JSON.stringify({
      canaryMachineId: 'old-one', secondMachineId: 'old-two', newImageRef: image,
      previousImageRef: previous, secondPreviousImageRef: previous, split: false,
    }));
    const executable = (name, body) => writeFileSync(join(root, 'bin', name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
    executable('flyctl', `
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const args = process.argv.slice(2);
state.calls.push({ tool: 'flyctl', args });
if (args[0] === 'deploy') {
  const id = args[args.indexOf('--only-machines') + 1];
  if (!state.machines.some(m => m.id === id)) process.exit(9);
  const image = args[args.indexOf('--image') + 1];
  state.machines = state.machines.filter(m => m.id !== id);
  state.machines.push({ id: 'replacement-' + id, state: 'started', config: { image } });
} else if (args[0] === 'machine' && args[1] === 'list') console.log(JSON.stringify(state.machines));
else process.exit(8);
fs.writeFileSync(process.env.STATE, JSON.stringify(state));
`);
    executable('curl', `
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const header = args.find(a => a.startsWith('fly-force-instance-id: '));
const machine = header?.slice('fly-force-instance-id: '.length);
const url = args.find(a => a.startsWith('https://'));
if (!state.machines.some(m => m.id === machine)) process.exit(9);
state.calls.push({ tool: 'curl', machine, url });
fs.writeFileSync(process.env.STATE, JSON.stringify(state));
const body = url.endsWith('/version') ? { version: process.env.RELEASE_VERSION, sourceSha: process.env.RELEASE_SHA }
  : url.endsWith('/health') ? { ok: true } : {};
if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(body));
if (args.includes('-w')) process.stdout.write('200');
`);
    // Exercise the real shell ordering without waiting through the existing
    // ninety-second observation period; verdict grading has its own suite.
    executable('sleep', 'process.exit(0);');
    executable('node', `
const args = process.argv.slice(2);
if (args[0] === 'packages/scripts/unified-release.mjs') {
  if (args[1] === 'server-canary-promotion') process.exit(process.env.REJECT_PROMOTION === 'true' ? 1 : 0);
  if (args[1] === 'server-canary-sample') {
    require('node:fs').writeFileSync(args[args.indexOf('--output') + 1], '{}');
    process.exit(0);
  }
  process.exit(8);
}
const result = require('node:child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    const result = spawnSync('bash', [testedScript, 'step11'], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root, STATE: stateFile,
        RELEASE_VERSION: 'v1.2.3', RELEASE_SHA: 'a'.repeat(40), SERVER_CANARY_REVIEW_SECRET: '',
        SERVER_CANARY_PHONE_TOKEN: 'fixture', SERVER_CANARY_ROOM_ID: 'room', REJECT_PROMOTION: String(failure === 'promotion') },
    });
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    const deployments = after.calls.filter(c => c.tool === 'flyctl' && c.args[0] === 'deploy');
    const targets = deployments.map(c => c.args[c.args.indexOf('--only-machines') + 1]);
    const probes = after.calls.filter(c => c.tool === 'curl');
    assert.ok(probes.length > 20, 'readiness, version, health and seven canary samples ran');
    assert.ok(probes.every(c => c.machine.startsWith('replacement-')));
    if (failure !== 'none') {
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(targets, failure === 'promotion' ? ['old-one', 'replacement-old-one']
        : ['old-one', 'old-two', 'replacement-old-one', 'replacement-old-two']);
      assert.match(result.stdout, /Rollback confirmed: every Machine runs its previous image/);
      assert.doesNotMatch(result.stderr, /CRITICAL/);
      assert.deepEqual(after.machines.map(m => m.id).sort(), failure === 'promotion'
        ? ['old-two', 'replacement-replacement-old-one']
        : ['replacement-replacement-old-one', 'replacement-replacement-old-two']);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(targets, ['old-one', 'old-two']);
      assert.ok(probes.some(c => c.machine === 'replacement-old-two' && c.url.endsWith('/readyz')));
      assert.ok(probes.filter(c => c.url.includes('/v1/phone/rooms/')).every(c => c.machine === 'replacement-old-one'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
