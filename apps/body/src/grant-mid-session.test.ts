import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_GRANT_SSH_OPTIONS } from '@beeline/api-contract/agent-grants';
import type { AgentSurface } from '@beeline/api-contract/surface-capabilities';
import { GrantCommandRunner } from './grant-runner.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Grant = {
  grantId: string;
  workspaceId: string;
  roomId?: string;
  kind: string;
  target: string;
  status: string;
  requestedBy: string;
  expiresAt?: number;
  capabilities?: string;
};

const hostGrant = (overrides: Partial<Grant> = {}): Grant => ({
  grantId: 'host-1',
  workspaceId: 'workspace',
  roomId: 'room',
  kind: 'host',
  target: 'do@100.126.74.60',
  status: 'approved',
  requestedBy: 'owner',
  ...overrides,
});

// A fake ssh on PATH prints the argv it got, so the test sees exactly what ran.
async function setup(grants: () => Grant[], surface: AgentSurface = 'room') {
  const root = await mkdtemp(join(tmpdir(), 'grant-host-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const ssh = join(bin, 'ssh');
  await writeFile(ssh, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(ssh, 0o755);
  const calls: { name: string; input: unknown }[] = [];
  const runner = new GrantCommandRunner({
    agentId: 'agent',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
    api: {
      execute: async (name: string, input: unknown) => {
        calls.push({ name, input });
        if (name === 'listTurnAgentGrants' || name === 'listAgentGrantRequests') return { grants: grants() };
        return {};
      },
    } as never,
  });
  runner.register('room', {
    workspaceId: 'workspace',
    cwd: root,
    turn: () => ({ requestId: 'request' }),
    writePolicy: () => ({ surface }),
  });
  return { runner, calls };
}

it('runs ssh to the approved login with fixed options and writes one ledger row', async () => {
  const { runner, calls } = await setup(() => [hostGrant()]);
  const result = await runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'uname -a'] });
  expect(result.grantId).toBe('host-1');
  expect(result.exitCode).toBe(0);
  expect(result.output.trim().split('\n')).toEqual([...HOST_GRANT_SSH_OPTIONS, '--', 'do@100.126.74.60', 'uname -a']);
  const rows = calls.filter((call) => call.name === 'postAgentActivity');
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0]!.input)).toContain('under grant host-1');
});

it('reads the grant list on every run, so a grant approved mid-session works at once', async () => {
  let grants: Grant[] = [];
  const { runner } = await setup(() => grants);
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'uptime'] })).rejects.toThrow(
    /No live host grant/,
  );
  grants = [hostGrant()];
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'uptime'] })).resolves.toMatchObject({
    grantId: 'host-1',
    exitCode: 0,
  });
});

it.each([
  ['wrong user', ['ssh', 'root@100.126.74.60', 'id']],
  ['wrong host', ['ssh', 'do@100.126.74.61', 'id']],
  ['agent ssh options', ['ssh', '-o', 'ProxyCommand=sh', 'do@100.126.74.60', 'id']],
  ['no remote command', ['ssh', 'do@100.126.74.60']],
])('refuses %s', async (_name, argv) => {
  const { runner, calls } = await setup(() => [hostGrant()]);
  await expect(runner.run({ roomId: 'room', argv })).rejects.toThrow(/no approved (host|command) grant matches/);
  expect(calls.some((call) => call.name === 'postAgentActivity')).toBe(false);
});

it('refuses an expired host grant', async () => {
  const { runner } = await setup(() => [hostGrant({ expiresAt: Math.floor(Date.now() / 1000) - 1 })]);
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] })).rejects.toThrow(
    /No live host grant/,
  );
});

it('refuses a revoked host grant, including one revoked between runs', async () => {
  let grants = [hostGrant()];
  const { runner } = await setup(() => grants);
  await runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] });
  grants = [hostGrant({ status: 'revoked' })];
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] })).rejects.toThrow(
    /No live host grant/,
  );
  grants = [];
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] })).rejects.toThrow(
    /No live host grant/,
  );
});

it('spends a once host grant before it runs', async () => {
  const { runner, calls } = await setup(() => [hostGrant({ status: 'once' })]);
  await runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] });
  expect(calls.find((call) => call.name === 'consumeAgentGrant')?.input).toEqual({ grantId: 'host-1' });
});

it('does not let a host grant from another workspace run', async () => {
  const { runner } = await setup(() => [hostGrant({ workspaceId: 'other' })]);
  await expect(runner.run({ roomId: 'room', argv: ['ssh', 'do@100.126.74.60', 'id'] })).rejects.toThrow(
    /No live host grant/,
  );
});

/** True when the fake bwrap was asked to bind `path` writable (path) or as a device. */
function grantedBind(output: string, path: string): boolean {
  const args = output.split('\n');
  return args.some((word, index) =>
    ['--bind', '--bind-try', '--dev-bind', '--dev-bind-try'].includes(word) && args[index + 1] === path);
}

// Path and device grants: the Room sandbox is built per run from the live
// grant list, so one approved after the session started is in the next run.
it.each([
  ['path', (root: string) => root],
  ['device', () => '/dev/null'],
])('loads a %s grant approved mid-session into the next run, without a new session', async (kind, target) => {
  let extra: Grant[] = [];
  const command: Grant = {
    grantId: 'cmd', workspaceId: 'workspace', kind: 'command', target: 'true', status: 'approved', requestedBy: 'owner',
  };
  const root = await mkdtemp(join(tmpdir(), 'grant-sandbox-'));
  roots.push(root);
  const bwrap = join(root, 'bwrap');
  await writeFile(bwrap, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(bwrap, 0o755);
  const runner = new GrantCommandRunner({
    agentId: 'agent',
    env: { PATH: process.env.PATH, HOME: root },
    api: {
      execute: async (name: string) =>
        name === 'listTurnAgentGrants' || name === 'listAgentGrantRequests' ? { grants: [command, ...extra] } : {},
    } as never,
  });
  runner.register('room', {
    workspaceId: 'workspace',
    cwd: root,
    turn: () => ({ requestId: 'request' }),
    writePolicy: () => ({ surface: 'room', bwrapPath: bwrap }),
  });
  const before = await runner.run({ roomId: 'room', argv: ['true'] });
  extra = [{ grantId: kind, workspaceId: 'workspace', roomId: 'room', kind, target: target(root), status: 'approved', requestedBy: 'owner', capabilities: 'write' }];
  const after = await runner.run({ roomId: 'room', argv: ['true'] });
  expect(grantedBind(before.output, target(root))).toBe(false);
  expect(grantedBind(after.output, target(root))).toBe(true);
});
