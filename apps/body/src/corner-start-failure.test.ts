import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import { distillTurnFailureReason, redactToolDetail } from './turn-failure-reason.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => {
  const work = resolve(root, 'work/work');
  if (existsSync(work)) chmodSync(work, 0o700);
  rmSync(root, { recursive: true, force: true });
}));

it.each([false, true])('runs thread commands as the host user without capabilities (overlay: %s)', overlay => {
  const root = mkdtempSync('/var/tmp/beeline-corner-user-');
  roots.push(root);
  const tree = resolve(root, 'node_modules');
  mkdirSync(tree);
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap',
    plan: sandboxMountPlan({ mode: 'edit', cwd: root, worktreePath: root,
      ...(overlay ? { dependencyLayers: [{ tree, upper: resolve(root, 'upper'), work: resolve(root, 'work') }] } : {}) }),
    cwd: root, command: process.execPath, args: ['-e', `
      const fs = require('node:fs');
      fs.writeFileSync('node_modules/written', 'private');
      const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)'], {stdio:'ignore'});
      if (child.error) throw child.error;
      console.log(JSON.stringify({uid:process.getuid(), gid:process.getgid(), child:child.status,
        status:fs.readFileSync('/proc/self/status','utf8')}));
    `] });
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const { uid, gid, child, status } = JSON.parse(result.stdout);
  expect(uid).toBe(process.getuid!());
  expect(uid).not.toBe(0);
  expect(gid).toBe(process.getgid!());
  expect(child).toBe(0);
  for (const cap of ['Inh', 'Prm', 'Eff', 'Bnd', 'Amb']) expect(status).toMatch(new RegExp(`Cap${cap}:\\s+0+\\n`));
  expect(status).toMatch(/NoNewPrivs:\s+1\n/);
  expect(existsSync(resolve(tree, 'written'))).toBe(!overlay);
});

it.each(['missing', 'dangling', 'loop', 'symlink'] as const)(
  'starts a thread with a %s saved path grant', shape => {
    const root = mkdtempSync('/var/tmp/beeline-corner-start-');
    roots.push(root);
    const grant = resolve(root, '.corner-artifacts/threads-refresh');
    const target = resolve(root, 'target');
    mkdirSync(resolve(root, '.corner-artifacts'));
    mkdirSync(target);
    if (shape !== 'missing') symlinkSync(shape === 'loop' ? grant :
      shape === 'dangling' ? resolve(root, 'deleted') : target, grant);
    // A read grant follows the agent to later corners, after the old artifact
    // is deleted. Its old pathname must never become a required startup mount.
    for (const writable of [false, true]) {
      const plan = sandboxMountPlan({ mode: 'edit', cwd: root, worktreePath: root,
        grantedPaths: [{ path: grant, writable }] });
      const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap', plan, cwd: root, command: '/usr/bin/true' });
      const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  },
);

it('retains writable grants through a symlink under a read-only root', () => {
  const root = mkdtempSync('/var/tmp/beeline-corner-start-');
  roots.push(root);
  const target = resolve(root, 'target'), alias = resolve(root, 'alias');
  mkdirSync(target); symlinkSync(target, alias);
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: root,
    grantedPaths: [{ path: alias, writable: true }] });
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap', plan, cwd: root,
    command: '/usr/bin/touch', args: [resolve(alias, 'written')] });
  expect(spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' }).stderr).toBe('');
  expect(execFileSync('/usr/bin/test', ['-f', resolve(target, 'written')])).toEqual(Buffer.alloc(0));
});

it('preserves the complete execFile rejection and its stderr past the long argv', () => {
  const argv = 'Command failed: /usr/bin/bwrap ' + '--bind /long/corner/path /long/corner/path '.repeat(50);
  const stderr = "bwrap: Can't find source path /deleted/.corner-artifacts/threads-refresh: No such file or directory\n";
  const error = Object.assign(new Error(argv + '\n' + stderr), { stderr });
  expect(distillTurnFailureReason(error).text).toBe((argv + '\n' + stderr).trim());
  // Some child-process wrappers attach stderr without including it in message.
  expect(distillTurnFailureReason(Object.assign(new Error(argv), { stderr: Buffer.from(stderr) })).text)
    .toBe((argv + '\n' + stderr).trim());
  const redacted = redactToolDetail(distillTurnFailureReason(Object.assign(new Error(argv), {
    stderr: stderr + 'TOKEN=private-value',
  })).text);
  expect(redacted).not.toContain('private-value');
  expect(redacted).toContain(stderr.trim());
});

it('keeps multi-line git diagnostics without carrying a JavaScript stack', () => {
  const message = 'Command failed: git fetch origin main\n' +
    'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
    "fatal: Authentication failed for 'https://github.com/Beeline-Work/beeline.git/'";
  expect(distillTurnFailureReason(new Error(message)).text).toBe(message);
});
