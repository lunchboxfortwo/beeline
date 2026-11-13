// Isolated built-service stand-in for R1/R2/R3; touches no real user service.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { credentialMaskPaths, sandboxMountPlan, buildBwrapArgv } from '../apps/body/dist/bwrap-sandbox.js';
import { createRoomPermissionHandler } from '../apps/body/dist/monolith-room-turn.js';
import { GrantCommandRunner, GrantRunnerServer } from '../apps/body/dist/grant-runner.js';

const root = mkdtempSync('/tmp/beeline-grant-proof-');
const home = resolve(root, 'home'); const target = resolve(root, 'project');
const runtime = resolve(root, 'run');
for (const dir of [home, target, runtime]) mkdirSync(dir);
const hidden = resolve(home, '.aws'); mkdirSync(hidden);
writeFileSync(resolve(hidden, 'sentinel'), 'fixture only');
const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1', `--address=unix:path=${runtime}/bus`]);
const deniedRoot = mkdtempSync('/var/tmp/beeline-denied-proof-');
let server;
try {
  await Promise.race([once(bus.stdout, 'data'), once(bus, 'error').then(([error]) => { throw error; })]);
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: home, operatorHome: home,
    userRuntimeDir: runtime, maskPaths: credentialMaskPaths(undefined, home) });
  const permissionHandler = createRoomPermissionHandler({ shellSandboxed: true, sandboxPlan: plan });
  assert.equal(await permissionHandler({ toolCall: { kind: 'edit', locations: [{ path: resolve(home, 'native-write') }] } }), 'allow');
  assert.equal(await permissionHandler({ toolCall: { kind: 'edit', locations: [{ path: resolve(hidden, 'native-write') }] } }), 'reject');
  const wrapped = buildBwrapArgv({ bwrapPath: 'bwrap', plan, cwd: home, command: process.execPath,
    args: ['-e', `const fs=require('fs');fs.writeFileSync('written','ok');
      if(fs.existsSync(process.env.HIDDEN+'/sentinel'))process.exit(42);`] });
  const initial = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: { ...process.env, HIDDEN: hidden } });
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(readFileSync(resolve(home, 'written'), 'utf8'), 'ok');
  console.log('R1 PASS: built non-edit sandbox writes HOME while masking fixture credentials');
  const pathGrants = [{ grantId: 'path', workspaceId: 'proof', kind: 'path', target, status: 'approved', capabilities: 'write' }];
  const runner = new GrantCommandRunner({ agentId: 'proof', env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime },
    api: { execute: async name => name === 'listTurnAgentGrants' ? { grants: [
      ...pathGrants,
      ...['touch', 'busctl'].map(command => ({ grantId: command, workspaceId: 'proof', kind: 'command',
        target: command, status: 'approved', requestedBy: 'fixture-owner' })),
    ] } : {} } });
  runner.register('proof', { workspaceId: 'proof', cwd: target,
    turn: () => ({ requestId: 'proof', generationId: 'proof' }),
    writePolicy: () => ({ surface: 'room', bwrapPath: '/usr/bin/bwrap', operatorHome: home,
      maskPaths: credentialMaskPaths(undefined, home) }) });
  server = new GrantRunnerServer(runner); const endpoint = await server.start();
  async function run(argv, expectedExit = 0) {
    const response = await fetch(`${endpoint.url}/run`, { method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'proof', argv }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.exitCode, expectedExit, result.output); return result;
  }
  await run(['touch', resolve(target, 'granted-write')]);
  assert.ok(existsSync(resolve(target, 'granted-write')));
  const connected = await run(['busctl', '--user', '--no-pager', 'list']);
  assert.match(connected.output, /org.freedesktop.DBus/);
  const deniedFile = resolve(deniedRoot, 'new-file');
  const refused = await run(['touch', deniedFile], 1);
  const hint = JSON.parse(refused.output.match(/Call request_grant\((.*)\)\./)[1]);
  assert.equal(hint.target, deniedRoot);
  pathGrants.push({ ...hint, grantId: 'hint', workspaceId: 'proof', status: 'approved' });
  await run(['touch', deniedFile]);
  assert.ok(existsSync(deniedFile));
  console.log('R3 PASS: following the exact denied-path hint allows the blocked write');
  console.log('R2/R3 PASS: built grant HTTP runner writes the granted path and reaches the isolated user bus');
} finally {
  await server?.close();
  const ended = once(bus, 'exit'); bus.kill(); await ended;
  rmSync(deniedRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
