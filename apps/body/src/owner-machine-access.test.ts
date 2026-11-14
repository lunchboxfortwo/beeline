import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createRoomPermissionHandler, roomPermissionDecision } from './room-permissions.js';
import { sandboxMountPlan, buildBwrapArgv, credentialMaskPaths, grantedSandboxPaths } from './bwrap-sandbox.js';
import { agentGrantAutoApproves, isPreapprovedReadOnlyCommand, parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { requestGrant, readGrantScript } from './read-only-mcp-agent-grant-deps.js';
import { GrantCommandRunner } from './grant-runner.js';

it.each([
  ['bash', '-c', 'printf approved'],
  ['python3', '-c', 'print("approved")'],
  ['node', '-e', 'console.log("approved")'],
  ['bash', '-c', 'python3 <<\'PY\'\nprint("approved")\nPY'],
])('R-SCRIPT-1 exact inline bytes for %s require approval and run repeatedly', async (...argv: string[]) => {
  const root = fixture();
  // The interpreter is never the script, even where setup-node makes it writable.
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute: async () => ({}) };
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
      .rejects.toThrow('no approved command grant');
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await runner.run({ roomId: 'room', argv });
    expect(result.exitCode).toBe(0); expect(result.output).toContain('approved');
  }
});

it('R-SCRIPT-2 node script.js reviews only script.js, even when node is a writable file on PATH', async () => {
  const root = fixture(); const bin = resolve(root, 'bin'); mkdirSync(bin);
  writeFileSync(resolve(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
  writeFileSync(resolve(bin, 'pnpm'), '#!/bin/sh\nprintf pnpm', { mode: 0o755 });
  writeFileSync(resolve(root, 'task.js'), 'console.log("approved")');
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: env, execute: async () => ({}) };
  const script = readGrantScript(parseCommandGrantTarget('node task.js'), deps);
  expect(script).toMatchObject({ path: 'task.js', contents: 'console.log("approved")' });
  expect(readGrantScript(parseCommandGrantTarget('pnpm build'), deps)).toBeUndefined();
  const grants = [{ grantId: 'node', workspaceId: 'workspace', kind: 'command', target: 'node task.js', status: 'approved', requestedBy: 'owner', script }];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { ...env, HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  expect((await runner.run({ roomId: 'room', argv: ['node', 'task.js'] })).output).toContain('approved');
  await expect(runner.run({ roomId: 'room', argv: ['node', 'task.js', 'unapproved-argument'] })).rejects.toThrow('no approved command grant');
  writeFileSync(resolve(root, 'task.js'), 'console.log("changed")');
  await expect(runner.run({ roomId: 'room', argv: ['node', 'task.js'] })).rejects.toThrow('script hash does not match');
});

it('R-SCRIPT-3 a long script is approved by path and content, and a changed one needs a new approval', async () => {
  const root = fixture();
  const body = '#!/bin/bash\n' + 'printf approved\n'.repeat(1_500);
  writeFileSync(resolve(root, 'proof.sh'), body, { mode: 0o755 });
  const deps = { roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: '/usr/bin:/bin' }, execute: async () => ({}) };
  for (const target of ['bash proof.sh', './proof.sh']) {
    const script = readGrantScript(parseCommandGrantTarget(target), deps);
    expect(script?.contents).toBe(body);
    const grants = [{ grantId: 'long', workspaceId: 'workspace', kind: 'command', target, status: 'approved', requestedBy: 'owner', script }];
    const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: '/usr/bin:/bin', HOME: root },
      api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
    runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
    expect((await runner.run({ roomId: 'room', argv: target.split(' ') })).output).toContain('approved');
    writeFileSync(resolve(root, 'proof.sh'), `${body}printf changed\n`, { mode: 0o755 });
    await expect(runner.run({ roomId: 'room', argv: target.split(' ') })).rejects.toThrow('script hash does not match');
    writeFileSync(resolve(root, 'proof.sh'), body, { mode: 0o755 });
  }
});

it('a summary git grant does not print a blob or a patch that contains a secret marker', async () => {
  const root = fixture();
  const git = (args: string[]) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8',
  });
  expect(git(['init']).status, git(['init']).stderr).toBe(0);
  writeFileSync(resolve(root, 'secret.txt'), 'PRIVATE_FIXTURE_MARKER\n');
  expect(git(['add', 'secret.txt']).status).toBe(0);
  expect(git(['commit', '-m', 'add secret']).status, git(['commit', '-m', 'add secret']).stderr).toBe(0);
  const blob = git(['rev-parse', 'HEAD:secret.txt']).stdout.trim();
  expect(git(['show', '--stat', blob]).stdout).toContain('PRIVATE_FIXTURE_MARKER');
  expect(git(['show', '--stat', '-p', 'HEAD']).stdout).toContain('PRIVATE_FIXTURE_MARKER');
  expect(git(['log', '-1', '-p']).stdout).toContain('PRIVATE_FIXTURE_MARKER');
  expect(git(['show', 'HEAD']).stdout).toContain('PRIVATE_FIXTURE_MARKER');
  expect(isPreapprovedReadOnlyCommand(['git', 'show', '--stat', blob])).toBe(false);
  expect(isPreapprovedReadOnlyCommand(['git', 'show', '--stat', blob.slice(0, 4)])).toBe(false);
  expect(isPreapprovedReadOnlyCommand(['git', 'show', '--stat', 'HEAD:secret.txt'])).toBe(false);
  expect(isPreapprovedReadOnlyCommand(['git', 'show', '--stat', '-p', 'HEAD'])).toBe(false);
  expect(isPreapprovedReadOnlyCommand(['gh', 'pr', 'diff'])).toBe(false);
  expect(isPreapprovedReadOnlyCommand(['gh', 'pr', 'diff', '12'])).toBe(false);
  // Each exact line is approved; a blob id or path still prints file contents.
  const grants = ['git show --stat HEAD', `git show --stat ${blob}`, `git show --stat ${blob.slice(0, 4)}`,
    'git show --stat HEAD:secret.txt', 'git show --stat', 'git log'].map((target, index) =>
    ({ grantId: `g${index}`, workspaceId: 'workspace', kind: 'command', target, status: 'approved', requestedBy: 'owner' }));
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: '/usr/bin:/bin', HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  const summary = await runner.run({ roomId: 'room', argv: ['git', 'show', '--stat', 'HEAD'] });
  expect(summary.output).not.toContain('PRIVATE_FIXTURE_MARKER');
  await expect(runner.run({ roomId: 'room', argv: ['git', 'show', '--stat', blob] })).rejects.toThrow(/file contents or a full patch/);
  await expect(runner.run({ roomId: 'room', argv: ['git', 'show', '--stat', blob.slice(0, 4)] })).rejects.toThrow(/file contents or a full patch/);
  await expect(runner.run({ roomId: 'room', argv: ['git', 'show', '--stat', 'HEAD:secret.txt'] })).rejects.toThrow(/file contents or a full patch/);
  // Words the approval never named are a different command.
  for (const argv of [['git', 'show', '--stat', '-p', 'HEAD'], ['git', 'log', '-1', '-p'], ['git', 'show', 'HEAD'], ['gh', 'pr', 'diff', '12']])
    await expect(runner.run({ roomId: 'room', argv })).rejects.toThrow('no approved command grant');
});

it('a git show probe never runs a writable git launcher', async () => {
  const root = fixture();
  const marker = resolve(root, 'probe-marker');
  writeFileSync(resolve(root, 'git'), `#!/bin/sh\ntouch '${marker}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const grants = [{ grantId: 'stat', workspaceId: 'workspace', kind: 'command', target: 'git show --stat HEAD', status: 'approved', requestedBy: 'owner' }];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: `${root}:/usr/bin:/bin`, HOME: root },
    api: { execute: async (op: string) => op === 'listTurnAgentGrants' ? { grants } : {} } as never });
  runner.register('room', { workspaceId: 'workspace', cwd: root, turn: () => ({ requestId: 'request', generationId: 'generation' }), writePolicy: () => ({ surface: 'corner' }) });
  await expect(runner.run({ roomId: 'room', argv: ['git', 'show', '--stat', 'HEAD'] })).rejects.toThrow(/file contents or a full patch/);
  expect(existsSync(marker)).toBe(false);
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
    expect(String(error)).toContain('word (2)'); expect(String(error)).toContain('expiry');
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
  const paths = grantedSandboxPaths({ grants: [{ ...calls[0], grantId: 'write', status: 'approved' }] });
  expect(paths).toEqual([{ path: target, writable: true }]);
  const plan = sandboxMountPlan({ mode: 'readonly', cwd: target, grantedPaths: paths });
  const child = buildBwrapArgv({ bwrapPath: 'bwrap', plan, cwd: target, command: '/usr/bin/touch', args: [resolve(target, 'written')] });
  expect(spawnSync(child.command, child.args).status).toBe(0);
  expect(existsSync(resolve(target, 'written'))).toBe(true);
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
      ...[['touch', resolve(target, 'granted-write')], ['busctl', '--user', '--no-pager', 'list']].map(argv => ({ grantId: argv[0], workspaceId: 'workspace', kind: 'command',
        target: JSON.stringify(argv), status: 'approved', requestedBy: 'owner' })),
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
    { grantId: 'touch', workspaceId: 'workspace', kind: 'command', target: JSON.stringify(['touch', outputPath]), status: 'approved', requestedBy: 'owner' },
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
