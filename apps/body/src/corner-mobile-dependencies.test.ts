import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { dependencyRequest, prepareDependencyGeneration } from './dependency-generation.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { identityFromKey } from './runtime.js';
import { mobileNodeModulesStoreDir } from './warm-node-modules.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(repositoryWork: boolean) {
  const root = await mkdtemp(resolve(tmpdir(), 'corner-mobile-'));
  roots.push(root);
  const checkout = resolve(root, 'checkout');
  const mobile = resolve(checkout, 'apps/mobile');
  const seed = resolve(root, 'seed');
  const home = resolve(root, 'home');
  await Promise.all([mobile, seed, home].map(path => mkdir(path, { recursive: true })));
  const lock = JSON.stringify({ name: 'mobile', lockfileVersion: 3,
    packages: { '': { name: 'mobile' }, 'node_modules/proof': { version: '1.0.0' } } });
  for (const path of [mobile, seed]) await writeFile(resolve(path, 'package-lock.json'), lock);
  await prepareDependencyGeneration({
    root: seed, store: mobileNodeModulesStoreDir(root), cache: resolve(root, 'cache'), npm: '/unused',
    install: async () => {
      await mkdir(resolve(seed, 'node_modules/proof'), { recursive: true });
      await writeFile(resolve(seed, 'node_modules/proof/package.json'), '{"name":"proof","version":"1.0.0"}');
      await writeFile(resolve(seed, 'node_modules/.package-lock.json'), '{"packages":{"node_modules/proof":{}}}');
    },
  });
  // Stop at the actual harness launch boundary, after dependency preparation
  // and sandbox construction. No real agent or CodeGraph process is started.
  const launch = vi.fn((_options: { agentArgs: string[] }) => { throw new Error('launch boundary'); });
  const loop = new MonolithCornerTurnLoop({
    runtime: { supervisorRoot: root, agent: { ...identityFromKey('11'.repeat(32), 'Bee'), secretKeyHex: '11'.repeat(32) } },
    config: { agentCommand: '/usr/bin/true', agentEnv: { HOME: home }, operatorHome: home, bwrapPath: '/usr/bin/bwrap' },
    worktreePath: checkout, cornerId: 'corner', parentRoomId: 'room', workspaceId: 'workspace',
    repository: { githubToken: 'fixture', featureBranch: 'feature', targetBranch: 'main', gitCommonDir: resolve(root, 'git') },
    api: { execute: vi.fn(async () => ({})), connection: () => ({}) }, createAcpClient: launch,
  } as never);
  roots.push(`${loop.commandContext.path}.resource-auth.json`);
  vi.spyOn(loop, 'configuration').mockResolvedValue({} as never);
  vi.spyOn(loop, 'roster').mockResolvedValue({ members: [] } as never);
  vi.spyOn(loop, 'grantedResources').mockResolvedValue({ hostRoutes: [], devices: [], isolatedCategories: [], paths: [] });
  vi.spyOn(loop, 'restoredState').mockResolvedValue({ brief: { repositoryWork } } as never);
  return { loop, launch, checkout, mobile };
}

it.each([
  { state: 'warm', repositoryWork: false },
  { state: 'cold', repositoryWork: false },
  { state: 'warm', repositoryWork: true },
  { state: 'cold', repositoryWork: true },
])('mounts requested mobile dependencies on the next $state activation (repositoryWork: $repositoryWork)', async ({ state, repositoryWork }) => {
  const { loop, launch, checkout, mobile } = await fixture(repositoryWork);
  const stop = vi.fn(async () => undefined);
  if (state === 'warm') {
    loop.client = { isAlive: true, hasBackgroundTools: true, stopProcess: stop } as never;
    loop.sessionId = 'warm-session';
    loop.sessionContextPath = loop.commandContext.path;
    expect(await loop.activate()).toBe('warm-session');
  }
  expect(existsSync(resolve(checkout, 'node_modules'))).toBe(false);
  expect(existsSync(resolve(mobile, 'node_modules'))).toBe(false);
  await writeFile(resolve(checkout, dependencyRequest), 'mobile');
  try {
    await expect(loop.activate()).rejects.toThrow('launch boundary');
    expect(await readFile(resolve(mobile, 'node_modules/proof/package.json'), 'utf8')).toContain('1.0.0');
    const args = launch.mock.calls[0][0].agentArgs;
    // The tree is mounted copy-on-write over a layer in this agent's private repository.
    const tree = resolve(mobile, 'node_modules'), at = args.indexOf(tree);
    expect(args.slice(at + 1, at + 3)).toEqual(['upper', 'work'].map(dir =>
      expect.stringMatching(new RegExp(`^${resolve(checkout, '..', 'git', 'beeline-dependency-layers')}/[0-9a-f-]+/${dir}$`))));
    expect(existsSync(resolve(checkout, 'node_modules'))).toBe(false);
    expect(existsSync(resolve(checkout, dependencyRequest))).toBe(false);
    if (state === 'warm') expect(stop).toHaveBeenCalledOnce();
    // A fulfilled request must not keep replacing subsequent warm sessions.
    loop.client = { isAlive: true, stopProcess: vi.fn() } as never;
    loop.sessionId = 'mounted-session';
    loop.sessionContextPath = loop.commandContext.path;
    expect(await loop.activate()).toBe('mounted-session');
    expect(launch).toHaveBeenCalledOnce();
  } finally { loop.squireRelay.close(); }
});

it('keeps a pending mobile request when preparation fails before harness launch', async () => {
  const { loop, launch, checkout } = await fixture(false);
  const root = loop.options.runtime.supervisorRoot;
  await rm(mobileNodeModulesStoreDir(root), { recursive: true, force: true });
  const installer = resolve(root, 'failed-installer');
  await writeFile(installer, '#!/bin/sh\necho fixture-install-failed >&2\nexit 1\n', { mode: 0o755 });
  loop.options.config.bwrapPath = installer;
  await writeFile(resolve(checkout, dependencyRequest), 'mobile');
  try {
    await expect(loop.activate()).rejects.toThrow('fixture-install-failed');
    expect(await readFile(resolve(checkout, dependencyRequest), 'utf8')).toBe('mobile');
    expect(launch).not.toHaveBeenCalled();
  } finally { loop.squireRelay.close(); }
});

it('prepares a requested mobile generation when the host mobile store is empty', async () => {
  const { loop, launch, checkout, mobile } = await fixture(false);
  const root = loop.options.runtime.supervisorRoot;
  await rm(mobileNodeModulesStoreDir(root), { recursive: true, force: true });
  // A local install stand-in exercises the sandboxed installer callback without
  // downloading packages. The generation and host store operations stay real.
  const installer = resolve(root, 'installer');
  await writeFile(installer, `#!${process.execPath}
const fs = require('node:fs');
fs.mkdirSync('node_modules/proof', { recursive: true });
fs.writeFileSync('node_modules/proof/package.json', '{"name":"proof","version":"1.0.0"}');
fs.writeFileSync('node_modules/.package-lock.json', '{"packages":{"node_modules/proof":{}}}');
`, { mode: 0o755 });
  loop.options.config.bwrapPath = installer;
  await writeFile(resolve(checkout, dependencyRequest), 'mobile');
  try {
    await expect(loop.activate()).rejects.toThrow('launch boundary');
    expect(await readFile(resolve(mobile, 'node_modules/proof/package.json'), 'utf8')).toContain('1.0.0');
    expect(launch.mock.calls[0][0].agentArgs).toContain(resolve(mobile, 'node_modules'));
    expect(existsSync(resolve(checkout, dependencyRequest))).toBe(false);
    expect(existsSync(resolve(checkout, 'node_modules'))).toBe(false);
  } finally { loop.squireRelay.close(); }
});
