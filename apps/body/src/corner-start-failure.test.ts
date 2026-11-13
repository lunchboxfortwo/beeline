import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import { roomRuntimeCoordinatorReportCornerStartFailure } from './room-runtime-refresh-room-checkout.js';
import { distillTurnFailureReason, redactToolDetail } from './turn-failure-reason.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it.each(['missing', 'dangling', 'loop', 'symlink'] as const)(
  'starts a corner with a %s saved path grant', shape => {
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

it('publishes the complete setup failure on its claimed receipt, with secrets scrubbed', async () => {
  const execute = vi.fn(async (operation: string) => {
    if (operation === 'getAgentCommands') return { commands: [{ id: 'input', action: 'input' }] };
    if (operation === 'claimAgentTurn') return { commands: [{ turnRequestId: 'request' }] };
    return {};
  });
  const message = 'Command failed: git ' + '--long-path '.repeat(50);
  const stderr = 'remote: Invalid username or token.\nfatal: Authentication failed\nTOKEN=private-value';
  const error = Object.assign(new Error(message), { stderr });
  const reported = await roomRuntimeCoordinatorReportCornerStartFailure({
    options: { daemonApi: { execute } }, agent: { publicKey: 'agent' },
  } as never, 'corner', error);
  expect(reported).toBe(true);
  const receipt = execute.mock.calls.find(call => call[0] === 'postAgentTurnReceipt') as unknown as
    [string, { reason: string }];
  expect(receipt[1].reason).toBe(redactToolDetail((message + '\n' + stderr).trim()));
  expect(receipt[1].reason).not.toContain('private-value');
});
