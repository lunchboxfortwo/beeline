import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createRoomPermissionHandler, roomPermissionDecision } from './monolith-room-turn.js';
import { sandboxMountPlan, buildBwrapArgv, credentialMaskPaths } from './bwrap-sandbox.js';
import { agentGrantAutoApproves, parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { requestGrant, readGrantScript } from './read-only-mcp-agent-grant-deps.js';
import { sessionGrantedResources } from './room-session.js';
import type { BodyConfig } from './config.js';
import { installedGrantExecutable } from './grant-script.js';
import { GrantCommandRunner } from './grant-runner.js';

it.each([
  ['bash', '-c', 'printf approved'],
  ['python3', '-c', 'print("approved")'],
  ['node', '-e', 'console.log("approved")'],
  ['bash', '-c', 'python3 <<\'PY\'\nprint("approved")\nPY'],
])('R-SCRIPT-1 exact inline bytes for %s require approval and run repeatedly', async (...argv: string[]) => {
  const root = fixture();
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute: async () => ({}) };
  // setup-node can point /usr/bin/node into a runner-writable tool cache.
  // That executable must be refused, not treated as an immutable interpreter.
  if (argv[0] === 'node' && !installedGrantExecutable({ path: 'node', direct: true }, root, deps.scriptEnv)) {
    expect(() => readGrantScript(parseCommandGrantTarget(JSON.stringify(argv)), deps)).toThrow('too long');
    return;
  }
  const script = readGrantScript(parseCommandGrantTarget(JSON.stringify(argv)), deps);
  expect(script?.contents).toBe(argv[2]);
  const grants = [{ grantId: 'inline', workspaceId: 'workspace', kind: 'command', target: JSON.stringify(argv), status: 'approved', requestedBy: 'owner' }];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: '/usr/bin:/bin', HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  await expect(runner.run({ roomId: 'room', argv })).rejects.toThrow('Closest grant inline');
  Object.assign(grants[0]!, { script });
  if (argv[0] === 'node') {
    await expect(runner.run({ roomId: 'room', argv: [...argv, '--import=data:text/javascript,console.log("unreviewed")'] }))
      .rejects.toThrow('code-loading options');
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await runner.run({ roomId: 'room', argv });
    expect(result.exitCode).toBe(0); expect(result.output).toContain('approved');
  }
});

it.each(['task', 'python3', 'node', 'env', 'timeout'])('R-SCRIPT-1 writable PATH %s scripts bind their bytes and a stale broad rule cannot hide a valid Always approval', async (name) => {
  const root = fixture(); const path = resolve(root, name);
  writeFileSync(path, '#!/bin/sh\nprintf approved', { mode: 0o755 });
  const script = readGrantScript(parseCommandGrantTarget(name + ' --version'), { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: root }, execute: async () => ({}) });
  expect(script?.contents).toContain('printf approved');
  const grant = { grantId: 'standing', workspaceId: 'workspace', kind: 'command', target: name, status: 'approved', requestedBy: 'owner', script };
  const grants = [{ ...grant, grantId: 'legacy', script: undefined }, grant];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: `${root}:/usr/bin:/bin`, HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  grants.splice(1, 1);
  await expect(runner.run({ roomId: 'room', argv: [name, '--version'] })).rejects.toThrow('script path or binding');
  grants.push(grant);
  expect((await runner.run({ roomId: 'room', argv: [name, '--version'] })).grantId).toBe('standing');
  writeFileSync(path, '#!/bin/sh\nprintf changed');
  await expect(runner.run({ roomId: 'room', argv: [name, '--version'] })).rejects.toThrow(/Closest grant.*script/);
  grants.splice(0, 1);
  await expect(runner.run({ roomId: 'room', argv: [name, '--version'] })).rejects.toThrow('script hash does not match');
  await expect(runner.run({ roomId: 'room', argv: ['different', 'private-value'] })).rejects.toThrow('prefix word (1)');
  expect(readGrantScript(parseCommandGrantTarget('echo approved'), { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute: async () => ({}) })).toBeUndefined();
});

it('R-GRANT-REFUSAL names an expired closest grant without echoing private argument values', async () => {
  const root = fixture();
  const runner = new GrantCommandRunner({ agentId: 'agent', api: { execute: async (op: string) => op === 'listAgentGrantRequests' ? { grants: [
    { grantId: 'expired-rule', workspaceId: 'workspace', kind: 'command', target: 'echo private-argument', status: 'approved', expiresAt: 1 },
  ] } : { grants: [] } } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  try { await runner.run({ roomId: 'room', argv: ['echo', 'different'] }); throw new Error('expected refusal'); }
  catch (error) {
    expect(String(error)).toContain('Closest grant expired-rule');
    expect(String(error)).toContain('prefix word (2)'); expect(String(error)).toContain('expiry');
    expect(String(error)).not.toContain('private-argument');
  }
});

it('an approved host grant names the command kind the run needs', async () => {
  const root = fixture();
  const runner = new GrantCommandRunner({ agentId: 'agent', api: { execute: async (op: string) => op === 'listAgentGrantRequests' ? { grants: [
    { grantId: 'host-rule', workspaceId: 'workspace', kind: 'host', target: 'api.example.com', status: 'approved' },
  ] } : { grants: [] } } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  await expect(runner.run({ roomId: 'room', argv: ['curl', 'https://api.example.com'] })).rejects.toThrow(/kind host[\s\S]*kind=command/);
});

it('R-SCRIPT-1 stdin is shown and byte-bound, while missing and changed input refuse', async () => {
  const root = fixture(); const argv = ['bash', '-s']; const stdin = 'printf approved';
  const target = JSON.stringify({ argv, stdin });
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute: async () => ({}) };
  expect(() => readGrantScript(parseCommandGrantTarget('bash -s'), deps)).toThrow('exact bytes');
  const script = readGrantScript(parseCommandGrantTarget(target), deps);
  expect(script?.contents).toBe(stdin);
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: '/usr/bin:/bin', HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants: [{ grantId: 'stdin', workspaceId: 'workspace', kind: 'command', target, status: 'approved', requestedBy: 'owner', script }] } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  expect((await runner.run({ roomId: 'room', argv, stdin })).output).toBe('approved');
  await expect(runner.run({ roomId: 'room', argv })).rejects.toThrow('stdin bytes are unavailable');
  await expect(runner.run({ roomId: 'room', argv, stdin: 'printf changed' })).rejects.toThrow('script hash does not match');
});

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(base = '/var/tmp') {
  const root = mkdtempSync(`${base}/beeline-access-`); roots.push(root); return root;
}

it.each(['/tmp', '/var/tmp'])('R1 writes the operator home under %s while keeping credentials and sibling work absent in a spawned readonly session', base => {
  const home = fixture(base);
  const hidden = resolve(home, '.aws');
  const sibling = resolve(home, 'other-agent');
  for (const path of [hidden, sibling]) { mkdirSync(path); writeFileSync(resolve(path, 'sentinel'), 'private'); }
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: home, operatorHome: home,
    maskPaths: [...credentialMaskPaths(undefined, home), { path: sibling, kind: 'dir' }] });
  const command = buildBwrapArgv({ bwrapPath: 'bwrap', plan, cwd: home, command: process.execPath,
    args: ['-e', `const fs=require('fs'); fs.writeFileSync('written','ok');
      if (fs.existsSync(process.env.HIDDEN+'/sentinel') || fs.existsSync(process.env.SIBLING+'/sentinel')) process.exit(42);`] });
  const child = spawnSync(command.command, command.args, { encoding: 'utf8', env: { ...process.env, HIDDEN: hidden, SIBLING: sibling } });
  expect(child.stderr).toBe(''); expect(child.status).toBe(0);
  expect(readFileSync(resolve(home, 'written'), 'utf8')).toBe('ok');
});

it('R1 startup asks the daemon policy and applies broad capabilities before masks', () => {
  const home = fixture();
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: home, operatorHome: home, userRuntimeDir: home });
  expect(plan.ownerPaths?.some(binding => binding.path === home && binding.writable))
    .toBe(agentGrantAutoApproves({ kind: 'path', target: home }));
  expect(Boolean(plan.userBus)).toBe(agentGrantAutoApproves({ kind: 'command', target: 'systemctl --user' }));
  const socket = resolve(home, 'docker.sock'); writeFileSync(socket, 'socket stand-in');
  const blocked = sandboxMountPlan({ mode: 'readonly', cwd: home, operatorHome: home, userRuntimeDir: home });
  expect(blocked.masks).toContainEqual({ path: socket, kind: 'file' });
  const explicit = sandboxMountPlan({ mode: 'readonly', cwd: home, userRuntimeDir: home,
    grantedPaths: [{ path: socket, writable: true }] });
  expect(explicit.masks.some(mask => mask.path === socket)).toBe(false);
});

it.each(['/tmp', '/var/tmp'])('R2 a write path grant under %s retains its capability from receipt to sandbox activation', async base => {
  const target = fixture(base); const calls: Record<string, unknown>[] = [];
  const result = await requestGrant({ kind: 'path', target, capabilities: 'read and write', reason: 'Build', purpose: 'Build project' }, {
    roomId: 'room', execute: async (_name, input) => { calls.push(input); return { auto: true, grantId: 'write' }; },
  });
  expect(result).toContain('read and write');
  const resources = await sessionGrantedResources({ operatorHome: target } as BodyConfig,
    async () => ({ grants: [{ ...calls[0], grantId: 'write', status: 'approved' }] }) as never);
  expect(resources.paths).toEqual([{ path: target, writable: true }]);
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: target, grantedPaths: resources.paths });
  const child = buildBwrapArgv({ bwrapPath: 'bwrap', plan, cwd: target, command: '/usr/bin/touch', args: [resolve(target, 'written')] });
  expect(spawnSync(child.command, child.args).status).toBe(0);
  expect(existsSync(resolve(target, 'written'))).toBe(true);
});

it('R2 writable PATH tools require readable script cards while interpreter files remain bound', async () => {
  const root = fixture(); const bin = resolve(root, 'bin'); mkdirSync(bin);
  writeFileSync(resolve(bin, 'pnpm'), '#!/bin/sh\n' + '# installed tool\n'.repeat(150), { mode: 0o755 });
  writeFileSync(resolve(root, 'task.js'), 'console.log("read me")');
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: bin },
    execute: async () => { throw new Error('oversized script must not create an ask'); } };
  await expect(requestGrant({ kind: 'command', target: 'pnpm build', reason: 'Build', purpose: 'Build project' }, deps)).rejects.toThrow('too long');
  expect(readGrantScript(parseCommandGrantTarget('node task.js'), deps)?.contents).toBe('console.log("read me")');
  expect(() => readGrantScript(parseCommandGrantTarget('./bin/pnpm build'), deps)).toThrow('too long');
});

it('R2 a fresh sandbox reaches a user bus only when the capability preserves its PID namespace', async () => {
  const runtime = fixture();
  const daemon = spawn('dbus-daemon', ['--session', '--nofork', `--address=unix:path=${runtime}/bus`], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(daemon);
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('test bus did not start')); }, 3000);
    const poll = setInterval(() => { if (existsSync(resolve(runtime, 'bus'))) { clearInterval(poll); clearTimeout(timeout); done(); } }, 10);
    daemon.once('error', reject);
  });
  const run = (access: boolean) => {
    const plan = sandboxMountPlan({ mode: 'readonly', cwd: runtime,
      ...(access ? { operatorHome: runtime, userRuntimeDir: runtime } : {}) });
    const command = buildBwrapArgv({ bwrapPath: 'bwrap', plan, cwd: runtime, command: 'busctl', args: ['--user', '--no-pager', 'list'] });
    if (access) expect(command.args).not.toContain('--unshare-pid');
    return spawnSync(command.command, command.args, { encoding: 'utf8', env: { ...process.env,
      XDG_RUNTIME_DIR: '/nonexistent', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' } });
  };
  expect(run(false).status).not.toBe(0);
  const allowed = run(true); expect(allowed.stderr).toBe(''); expect(allowed.status).toBe(0);
  expect(allowed.stdout).toContain('org.freedesktop.DBus');
  // R3 exercises the actual run_granted_command runner, including its live ledger read.
  const target = fixture();
  const runner = new GrantCommandRunner({ agentId: 'agent',
    env: { PATH: process.env.PATH, HOME: runtime, XDG_RUNTIME_DIR: runtime },
    api: { execute: async (operation: string) => operation === 'listTurnAgentGrants' ? { grants: [
      { grantId: 'write', workspaceId: 'workspace', kind: 'path', target, status: 'approved', capabilities: 'write' },
      ...['touch', 'busctl'].map(command => ({ grantId: command, workspaceId: 'workspace', kind: 'command',
        target: command, status: 'approved', requestedBy: 'owner' })),
    ] } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: target,
    turn: () => ({ requestId: 'request', generationId: 'generation' }),
    writePolicy: () => ({ surface: 'room', bwrapPath: '/usr/bin/bwrap', operatorHome: runtime }) });
  const written = await runner.run({ roomId: 'room', argv: ['touch', resolve(target, 'granted-write')] });
  expect(written.output).toBe(''); expect(written.exitCode).toBe(0);
  expect(existsSync(resolve(target, 'granted-write'))).toBe(true);
  const connected = await runner.run({ roomId: 'room', argv: ['busctl', '--user', '--no-pager', 'list'] });
  expect(connected.exitCode).toBe(0); expect(connected.output).toContain('org.freedesktop.DBus');
});

it('R1 the non-edit session permission callback permits covered native edits and rejects protected paths and symlink escapes', async () => {
  const home = fixture('/tmp'); const outside = fixture();
  const privateHome = resolve(home, 'agent-home'); mkdirSync(privateHome);
  const protectedDir = resolve(home, 'protected'); mkdirSync(protectedDir);
  const credentialDir = resolve(home, '.aws'); mkdirSync(credentialDir);
  const sibling = resolve(home, 'sibling'); mkdirSync(sibling);
  symlinkSync(outside, resolve(home, 'escape'));
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: home, operatorHome: home,
    protectedPaths: [protectedDir], maskPaths: [{ path: credentialDir, kind: 'dir' }, { path: sibling, kind: 'dir' }] });
  const options = { shellSandboxed: true, sandboxHome: privateHome, sandboxPlan: plan };
  expect(roomPermissionDecision({ toolCall: { kind: 'edit', locations: [{ path: resolve(home, 'project', 'new.txt') }] } }, options)).toBe('allow');
  const callback = createRoomPermissionHandler(options);
  for (const [path, expected] of [
    [resolve(home, 'project', 'new.txt'), 'allow'], [resolve(privateHome, 'note'), 'allow'],
    [resolve(credentialDir, 'new.txt'), 'reject'], [resolve(sibling, 'new.txt'), 'reject'],
    [resolve(protectedDir, 'new.txt'), 'reject'], [resolve(outside, 'new.txt'), 'reject'],
    [resolve(home, 'escape', 'new.txt'), 'reject'],
  ]) expect(await callback({ toolCall: { kind: 'edit', locations: [{ path }] } })).toBe(expected);
});

it('R3 following a denied-path hint grants the location the command actually writes', async () => {
  const home = fixture(); const target = fixture();
  const outputPath = resolve(target, 'written'); const grants: Record<string, unknown>[] = [
    { grantId: 'touch', workspaceId: 'workspace', kind: 'command', target: 'touch', status: 'approved', requestedBy: 'owner' },
  ];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: process.env.PATH, HOME: home },
    api: { execute: async (operation: string) => operation === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: home,
    turn: () => ({ requestId: 'request', generationId: 'generation' }),
    writePolicy: () => ({ surface: 'room', bwrapPath: '/usr/bin/bwrap', operatorHome: home }) });
  const refused = await runner.run({ roomId: 'room', argv: ['touch', outputPath] });
  expect(refused.exitCode).not.toBe(0);
  const hint = JSON.parse(refused.output.match(/Call request_grant\((.*)\)\./)![1]!);
  expect(hint.target).toBe(target);
  // A file that does not exist needs its containing directory writable to create it.
  expect(hint.target).not.toBe(home);
  grants.push({ ...hint, grantId: 'write', workspaceId: 'workspace', status: 'approved' });
  const allowed = await runner.run({ roomId: 'room', argv: ['touch', outputPath] });
  expect(allowed.exitCode).toBe(0); expect(existsSync(outputPath)).toBe(true);
});
