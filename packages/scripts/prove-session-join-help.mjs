// Exercise the built public CLI, with isolated HOME and forbidden networking.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transform } from 'esbuild';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, '.beeline-proof/agent-invitations/join-help');
mkdirSync(out, { recursive: true });
const preload = resolve(out, 'no-network.mjs');
writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("Unexpected network during help"); };\n');
const compiled = resolve(root, 'apps/body/dist/session-join/command.js');
const current = readFileSync(compiled);
const before = process.argv.includes('--before');
try {
  if (before) {
    const source = execFileSync('git', ['show', '584c304f5:apps/body/src/session-join/command.ts'], { encoding: 'utf8' });
    writeFileSync(compiled, (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
  }
  const rows = [];
  for (const flag of ['--help', '-h']) {
    const home = resolve(out, `${before ? 'before' : 'after'}-${flag.replaceAll('-', '')}`);
    mkdirSync(home, { recursive: true });
    const run = spawnSync(process.execPath, ['--import', preload, resolve(root, 'apps/body/dist/recovery-cli.js'), 'join', flag], {
      env: { ...process.env, HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home },
      encoding: 'utf8', timeout: 15000,
    });
    const writes = readdirSync(home);
    rows.push({ flag, status: run.status, stdout: run.stdout, stderr: run.stderr, homeWrites: writes,
      pass: run.status === 0 && run.stdout.startsWith('Usage: usebeeline join ') && writes.length === 0 });
  }
  writeFileSync(resolve(out, before ? 'before.json' : 'after.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(`Reproduction linux-join-validation-1: built join help → ${rows.every(row => row.pass) ? 'usage, exit zero, no sign-in or state writes' : 'does not show help without side effects'}`);
  assert.ok(rows.every(row => row.pass), 'Both help flags must print usage without sign-in or state writes');
} finally { writeFileSync(compiled, current); }
