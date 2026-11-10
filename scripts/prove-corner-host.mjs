#!/usr/bin/env node
// Narrow host proof: no live emulator lease, model, production daemon or login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { GrantCommandRunner } from '../apps/body/dist/grant-runner.js';
import { buildAgentEnv } from '../apps/body/dist/config.js';
import { AcpClient } from '../apps/body/dist/acp.js';
import { startAgentProcess, stopAgentProcess } from '../apps/body/dist/agent-process.js';

const launcher = process.argv[2];
if (!launcher) throw new Error('Usage: node scripts/prove-corner-host.mjs <installed @openai/codex/bin/codex.js>');
const temporary = mkdtempSync(resolve(tmpdir(), 'beeline-host-proof-'));
try {
  const tools = resolve(temporary, 'android-sdk/platform-tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(resolve(tools, 'adb'), '#!/bin/sh\nprintf "emulator-5554\\tdevice\\n"\n', { mode: 0o755 });
  const env = buildAgentEnv({ HOME: temporary, PATH: '/usr/bin:/bin' });
  assert.match(execFileSync('adb', ['devices'], { env, encoding: 'utf8' }), /emulator-5554/);
  console.log('Reproduction corner-host: built helper PATH -> adb command returns fixture device');

  const bin = resolve(temporary, 'codex/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(resolve(bin, '../package.json'), '{"type":"module"}');
  copyFileSync(launcher, resolve(bin, 'codex.js'));
  const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [resolve(bin, 'codex.js')], agentEnv: {}, resourceScope: 'none' });
  try {
    await assert.rejects(startAgentProcess(client), /missing platform package @openai\/codex-linux-x64/);
    console.log('Reproduction corner-host: real Codex launcher without Linux package -> named missing-package error');
  } finally { await stopAgentProcess(client); }

  const checkout = resolve(temporary, 'latency-rig');
  execFileSync('git', ['clone', '--shared', '--no-hardlinks', '--no-checkout', process.cwd(), checkout], { stdio: 'pipe' });
  execFileSync('git', ['-C', checkout, 'checkout', 'HEAD', '--', 'README.md']);
  const writable = execFileSync('mktemp', [resolve(checkout, '.write-proof.XXXXXX')], { encoding: 'utf8' }).trim();
  assert.ok(writable.startsWith(checkout));
  console.log('Reproduction corner-host: latency scratch clone -> checkout write succeeds');

  const directory = resolve(temporary, 'host-job');
  const script = 'scripts/corner-job.mjs';
  const build = resolve(temporary, 'build.cjs');
  writeFileSync(build, 'console.log("cross-turn build output"); setTimeout(() => {process.exitCode = 7}, 250)');
  const argv = [process.execPath, script, 'start', directory, process.execPath, build];
  const grant = { grantId: 'fixture', workspaceId: 'workspace', kind: 'command', status: 'approved',
    requestedBy: 'fixture-owner', target: argv.join(' '),
    script: { path: script, sha256: createHash('sha256').update(readFileSync(script)).digest('hex') } };
  let active = true;
  const runner = new GrantCommandRunner({ agentId: 'fixture', env: { PATH: process.env.PATH, HOME: temporary },
    api: { execute: async name => name === 'listTurnAgentGrants' ? { grants: [grant] } : {} } });
  runner.register('room', { workspaceId: 'workspace', cwd: process.cwd(),
    writePolicy: () => ({ surface: 'corner' }),
    turn: () => active ? { requestId: 'turn-one', generationId: 'generation-one' } : undefined });
  const launched = await runner.run({ roomId: 'room', argv });
  assert.equal(launched.exitCode, 0, launched.output);
  active = false; // The launching turn has ended. The host owns the child now.
  for (let attempt = 0; attempt < 100 && !existsSync(resolve(directory, 'result.json')); attempt++) await pause(50);
  assert.equal(JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8')).exitCode, 7);
  assert.match(execFileSync(process.execPath, [script, 'status', directory], { encoding: 'utf8' }), /cross-turn build output/);
  console.log('Reproduction corner-host: built grant runner returns; ended turn retains host job output and exit status');

  execFileSync(process.execPath, ['--test', 'scripts/corner-job.test.mjs', 'scripts/android-build-failure.test.mjs'], { stdio: 'inherit' });
  console.log('Reproduction corner-host: detached host build -> next command reads log and failing exit status; Android build reports failed stage');
} finally { rmSync(temporary, { recursive: true, force: true }); }
