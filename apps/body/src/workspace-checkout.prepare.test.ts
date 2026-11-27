import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { SessionResources } from './session-resources.js';
import * as wait from './wait.js';
import { prepareWorkspace } from './workspace-checkout.js';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import { workspaceDependenciesDir } from './dependency-generation.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const commit = async (source: string, version: string) => {
  await writeFile(join(source, 'version.txt'), `${version}\n`);
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', [
    '-C',
    source,
    '-c',
    'user.name=Proof',
    '-c',
    'user.email=proof@example.com',
    'commit',
    '-m',
    version,
  ]);
};

async function threadCheckout(configured = async () => {}) {
  const root = await mkdtemp(`${testTmpDir()}/beeline-checkout-`);
  roots.push(root);
  const source = join(root, 'source');
  await exec('git', ['init', '-b', 'main', source]);
  await commit(source, 'v1');
  const repository = { resolution: 'repository', remote: `file://${source}`, targetBranch: 'main' };
  const readRepository = vi.fn(async () => repository);
  const postWorking = vi.fn(async () => ({}));
  const api = {
    execute: (name: string) => {
      if (name === 'getRoomRepositoryState') return readRepository();
      if (name === 'getCornerRestoreState') return Promise.resolve({});
      if (name === 'postCornerRemoteState') return postWorking();
      throw new Error(`Unexpected repository operation ${name}`);
    },
  } as unknown as DaemonApiClient;
  const placeId = 'thread';
  const agent = { name: 'Proof', publicKey: 'a'.repeat(64) };
  const location = { api, placeId, parentRoomId: 'room', workspaceId: 'workspace' };
  const workspace = (homeReady?: Promise<void>) =>
    prepareWorkspace(
      { ...location, config: {} as BodyConfig, supervisorRoot: root, agent },
      homeReady,
    );
  const session = new SessionResources({
    ...location,
    agentId: agent.publicKey,
    cachePath: join(root, 'session.json'),
    configured,
    checkout: workspace,
  });
  return {
    source,
    readRepository,
    postWorking,
    workspace,
    session,
    ...agentCornerCheckoutPaths(root, placeId, agent.publicKey),
  };
}

it('workspace joins session prepare while agent home setup is pending', async () => {
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const f = await threadCheckout(() => {
    reached.resolve();
    return resume.promise;
  });
  const prepare = f.session.prepare();
  await Promise.race([reached.promise, prepare]);
  const workspace = f.workspace();
  const returnedDuringSetup = await Promise.race([
    workspace.then(() => true, () => true),
    setImmediate(false),
  ]);
  const readsDuringSetup = f.readRepository.mock.calls.length;
  resume.resolve();
  const [ready] = await Promise.all([workspace, prepare]);

  expect(returnedDuringSetup).toBe(false);
  expect(readsDuringSetup).toBe(0);
  expect(f.readRepository).toHaveBeenCalledTimes(1);
  expect(f.postWorking).toHaveBeenCalledTimes(1);
  const head = (await exec('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim();
  expect(ready).toContain(`HEAD is ${head}.`);
  expect(ready).toBe(f.session.status.checkout);
});

it('workspace joins session prepare for the same checkout and returns its prepared head', async () => {
  const f = await threadCheckout();
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const runGit = wait.runOwnedFile;
  vi.spyOn(wait, 'runOwnedFile').mockImplementation(async (file, args, options) => {
    if (file === 'git' && args[0] === `--git-dir=${f.gitCommonDir}.creating` && args[1] === 'fsck') {
      reached.resolve();
      await resume.promise;
    }
    return runGit(file, args, options);
  });
  const prepare = f.session.prepare();
  await Promise.race([reached.promise, prepare]);
  const lock = await wait.tryLock(`thread-checkout:${f.path}`);
  if (lock.held) await lock.release();
  else lock.close();
  const workspace = f.workspace();
  const returnedDuringPrepare = await Promise.race([
    workspace.then(() => true, () => true),
    setImmediate(false),
  ]);
  const readsDuringPrepare = f.readRepository.mock.calls.length;
  resume.resolve();
  const [ready] = await Promise.all([workspace, prepare]);

  expect(lock.held).toBe(false);
  expect(returnedDuringPrepare).toBe(false);
  expect(readsDuringPrepare).toBe(1);
  expect(f.postWorking).toHaveBeenCalledTimes(1);
  expect(ready).toContain(`Checkout ready at ${f.path}`);
  expect(ready).toBe(f.session.status.checkout);
  const head = (await exec('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim();
  expect(ready).toContain(`HEAD is ${head}.`);
  expect((await exec('git', ['-C', f.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
});

it('clears abandoned Git staging after the Git directory was already installed', async () => {
  const f = await threadCheckout();
  await f.workspace();
  // A stopped owner may have moved HEAD into place but never cleaned this directory.
  const staging = `${f.gitCommonDir}.creating`;
  await mkdir(staging);
  await writeFile(join(staging, 'leftover'), 'abandoned');
  await commit(f.source, 'v2');

  expect(await f.workspace()).toContain(`Checkout ready at ${f.path}`);
  expect(existsSync(staging)).toBe(false);
  expect(await readFile(join(f.path, 'version.txt'), 'utf8')).toBe('v2\n');
});

it('session prepare clears the previous ready status while the checkout is at the old head', async () => {
  const f = await threadCheckout();
  await f.session.prepare();
  await commit(f.source, 'v2');
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readRepository = f.readRepository.getMockImplementation()!;
  f.readRepository.mockImplementationOnce(async () => {
    reached.resolve();
    await resume.promise;
    return readRepository();
  });
  const prepare = f.session.prepare();
  await Promise.race([reached.promise, prepare]);
  try {
    expect(await readFile(join(f.path, 'version.txt'), 'utf8')).toBe('v1\n');
    expect(f.session.status).toMatchObject({ checkout: 'loading', setup: 'loading' });
  } finally {
    resume.resolve();
    await prepare;
  }
  expect(f.session.status.setup).toBe('ready');
  expect(f.session.status.checkout).toContain(`Checkout ready at ${f.path}`);
  expect(await readFile(join(f.path, 'version.txt'), 'utf8')).toBe('v2\n');
});

it('finishes installing tracked files after an interrupted worktree attachment', async () => {
  const f = await threadCheckout();
  await writeFile(join(f.source, 'keep.txt'), 'original\n');
  await commit(f.source, 'v2');
  const runGit = wait.runOwnedFile;
  const git = vi.spyOn(wait, 'runOwnedFile').mockImplementation(async (file, args, options) => {
    if (file === 'git' && args.includes('checkout-index')) {
      await writeFile(join(f.path, 'keep.txt'), 'local edit\n');
      throw new Error('worktree install interrupted');
    }
    return runGit(file, args, options);
  });
  await expect(f.workspace()).rejects.toThrow('worktree install interrupted');
  git.mockRestore();
  expect(existsSync(join(f.path, '.git'))).toBe(true);
  expect(existsSync(join(f.path, 'version.txt'))).toBe(false);

  expect(await f.workspace()).toContain(`Checkout ready at ${f.path}`);
  expect(await readFile(join(f.path, 'version.txt'), 'utf8')).toBe('v2\n');
  expect(await readFile(join(f.path, 'keep.txt'), 'utf8')).toBe('local edit\n');
});

it('installs tracked files on retry after Git registers a temporary worktree', async () => {
  const f = await threadCheckout();
  const runGit = wait.runOwnedFile;
  const git = vi.spyOn(wait, 'runOwnedFile').mockImplementation(async (file, args, options) => {
    const result = await runGit(file, args, options);
    if (file === 'git' && args[1] === 'worktree' && args[2] === 'add')
      throw new Error('worktree attachment stopped after registration');
    return result;
  });
  await expect(f.workspace()).rejects.toThrow('worktree attachment stopped after registration');
  git.mockRestore();
  const linkedWorktrees = () =>
    exec('git', [`--git-dir=${f.gitCommonDir}`, 'worktree', 'list', '--porcelain']);
  expect((await linkedWorktrees()).stdout).toContain('/.reattach-');
  expect(existsSync(join(f.path, '.git'))).toBe(false);

  expect(await f.workspace()).toContain(`Checkout ready at ${f.path}`);
  expect(await readFile(join(f.path, 'version.txt'), 'utf8')).toBe('v1\n');
  expect((await linkedWorktrees()).stdout).not.toContain('/.reattach-');
});

/** A repository whose first test run needs installed packages and built output. */
async function fixture(
  scripts: Record<string, string>,
  restore: { brief?: { spec: string } } = {},
  packageManager: 'npm' | 'pnpm' = 'npm',
) {
  const root = await mkdtemp(`${testTmpDir()}/beeline-prepare-`);
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'dep'), { recursive: true });
  await exec('git', ['init', '-b', 'main', source]);
  await writeFile(join(source, 'dep', 'package.json'), '{"name":"dep","version":"1.0.0"}\n');
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: { dep: 'file:dep' },
      ...(packageManager === 'pnpm' ? { packageManager: 'pnpm@10.34.5' } : {}),
      scripts,
    }),
  );
  await writeFile(
    join(source, 'build.mjs'),
    [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "mkdirSync('dist', { recursive: true });",
      "writeFileSync('dist/built.txt', readFileSync('version.txt'));",
    ].join('\n'),
  );
  await writeFile(join(source, '.gitignore'), 'node_modules/\ndist/\n');
  if (packageManager === 'pnpm') {
    await writeFile(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const bin = join(root, 'bin');
    await mkdir(bin);
    const npm = (await exec('which', ['npm'])).stdout.trim();
    await writeFile(join(bin, 'npm'), [
      '#!/bin/sh',
      `[ "$1" = "exec" ] || exec '${npm}' "$@"`,
      '[ "$*" = "exec --yes --package=pnpm@10.34.5 -- pnpm install --frozen-lockfile" ] || exit 1',
      'mkdir -p node_modules && cp -r dep node_modules/dep',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  } else {
    await exec(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: source },
    );
  }
  await commit(source, 'v1');
  const repository = { resolution: 'repository', remote: `file://${source}`, targetBranch: 'main' };
  const api = {
    execute: async (name: string) =>
      name === 'getRoomRepositoryState'
        ? repository
        : name === 'getCornerRestoreState'
          ? restore
          : {},
  } as unknown as DaemonApiClient;
  const supervisorRoot = join(root, 'state');
  const config = {
    workspaceRoot: join(root, 'place'),
    operatorHome: join(root, 'operator'),
    agentEnv: {},
    bwrapPath: '/usr/bin/bwrap',
  } as unknown as BodyConfig;
  return {
    source,
    config,
    restore,
    prepare: (parentRoomId?: string, placeId = 'place') =>
      prepareWorkspace({
        api,
        config,
        supervisorRoot,
        workspaceId: 'workspace',
        agent: { name: 'Proof', publicKey: 'a'.repeat(64) },
        placeId,
        ...(parentRoomId ? { parentRoomId } : {}),
      }),
  };
}

it.each([
  {
    surface: 'thread',
    parentRoomId: 'room',
    scripts: { 'corner:prepare': 'npm ci && node build.mjs' },
  },
  { surface: 'Room', parentRoomId: undefined, scripts: { build: 'node build.mjs' } },
])(
  'prepare readies a $surface checkout at the current base before it says ready',
  async ({ parentRoomId, scripts }) => {
    const f = await fixture(scripts);
    const ready = async (version: string) => {
      const result = await f.prepare(parentRoomId);
      expect(result).toContain('Checkout ready at ');
      const path = result.slice('Checkout ready at '.length).split(' on ')[0]!;
      expect(await readFile(join(path, 'version.txt'), 'utf8')).toBe(`${version}\n`);
      expect(existsSync(join(path, 'node_modules', 'dep', 'package.json'))).toBe(true);
      expect(await readFile(join(path, 'dist', 'built.txt'), 'utf8')).toBe(`${version}\n`);
    };
    await ready('v1');
    // The base moves on while this agent's existing checkout waits for its next session.
    await commit(f.source, 'v2');
    await ready('v2');
  },
);

it('prepare reports a failed build step instead of a ready checkout', async () => {
  const f = await fixture({ build: 'node -e "process.exit(3)"' });
  await expect(f.prepare('room')).rejects.toThrow(/is not ready: npm run build failed/);
});

it('installs a pnpm checkout from its lockfile before building', async () => {
  const f = await fixture({ build: 'test -f node_modules/dep/package.json && node build.mjs' }, {}, 'pnpm');
  const result = await f.prepare('room');
  expect(result).toContain('Checkout ready at ');
  const path = result.slice('Checkout ready at '.length).split(' on ')[0]!;
  expect(await readFile(join(path, 'dist', 'built.txt'), 'utf8')).toBe('v1\n');
});

it('prepare says the checkout is not ready when no OS sandbox can run its scripts', async () => {
  const f = await fixture({ build: 'node build.mjs' });
  delete f.config.bwrapPath;
  const result = await f.prepare('room');
  expect(result).not.toContain('Checkout ready');
  expect(result).toContain(
    'is not ready: packages were not installed and the build step did not run',
  );
});

it('prepare hands its step the thread brief and a writable temp folder tests can use', async () => {
  const record = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.TMPDIR + '/probe', 'written');",
    "fs.writeFileSync('prepared.json', JSON.stringify({ brief: process.env.BEELINE_BRIEF, tmp: process.env.TMPDIR }));",
  ].join(' ');
  const f = await fixture(
    { 'corner:prepare': `node -e ${JSON.stringify(record)}` },
    { brief: { spec: 'Fix the phone app in apps/mobile.' } },
  );
  const prepared = async () => {
    const result = await f.prepare('room');
    expect(result).toContain('Checkout ready at ');
    const path = result.slice('Checkout ready at '.length).split(' on ')[0]!;
    return JSON.parse(await readFile(join(path, 'prepared.json'), 'utf8'));
  };
  const first = await prepared();
  expect(first.brief).toBe('Fix the phone app in apps/mobile.');
  // Test helpers root their folders in TMPDIR only under /var/tmp.
  expect(first.tmp).toMatch(/^\/var\/tmp\//);
  // A revised brief prepares again even though the tree did not change.
  f.restore.brief = { spec: 'Fix the server read path.' };
  expect((await prepared()).brief).toBe('Fix the server read path.');
});

it('shares matching root and mobile installs through sealed workspace paths and replaces a changed generation', async () => {
  const f = await fixture({
    'corner:prepare': 'node packages/scripts/prepare-corner.mjs',
    'mobile:install': 'exit 1',
  }, { brief: { spec: 'Prepare the mobile app.' } });
  const source = f.source;
  await mkdir(join(source, 'packages/scripts'), { recursive: true });
  await writeFile(join(source, 'packages/scripts/prepare-corner.mjs'), `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    assert.equal(process.env.BEELINE_READONLY_DEPENDENCIES, '1');
    assert.equal(process.env.BEELINE_MOBILE_DEPENDENCIES_READY, '1');
    assert.equal(createRequire(process.cwd() + '/package.json')('dep'), 'shared');
    assert.equal(createRequire(process.cwd() + '/apps/mobile/package.json')('dep'), 'shared');
  `);
  await writeFile(join(source, 'dep', 'index.js'), "module.exports = 'shared';");
  const { stdout } = await exec('npm', ['pack', './dep', '--json'], { cwd: source });
  const tarball = (JSON.parse(stdout) as { filename: string }[])[0]!.filename;
  const manifestPath = join(source, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dependencies.dep = `file:${tarball}`;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mobile = join(source, 'apps/mobile');
  await mkdir(mobile, { recursive: true });
  await writeFile(join(mobile, 'package.json'), JSON.stringify({
    name: 'fixture-mobile', dependencies: { dep: `file:../../${tarball}` },
  }));
  for (const cwd of [source, mobile])
    await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit'], { cwd });
  await commit(source, 'managed');

  const prepare = async (id: string) => {
    const result = await f.prepare('room', id);
    expect(result).toContain('Checkout ready at ');
    return result.slice('Checkout ready at '.length).split(' on ')[0]!;
  };
  const first = await prepare('first');
  const second = await prepare('second');
  const inode = async (root: string, path: string) => (await stat(join(root, path))).ino;
  const dependency = 'node_modules/dep/index.js';
  expect(await inode(first, dependency)).toBe(await inode(second, dependency));
  expect(await inode(first, `apps/mobile/${dependency}`))
    .toBe(await inode(second, `apps/mobile/${dependency}`));

  const { stdout: gitDir } = await exec('git', ['-C', first, 'rev-parse', '--git-common-dir']);
  const gitCommonDir = gitDir.trim();
  const command = wrapAgentCommand({
    bwrapPath: f.config.bwrapPath,
    spec: {
      mode: 'edit', cwd: first, worktreePath: first, gitCommonDir,
      sealedPaths: [join(gitCommonDir, workspaceDependenciesDir)],
    },
    command: 'chmod',
    args: ['u+w', dependency],
  });
  await expect(exec(command.command, command.args, { cwd: first })).rejects.toThrow(/Read-only file system/);

  const old = await inode(first, dependency);
  const lockfile = join(first, 'package-lock.json');
  await writeFile(lockfile, (await readFile(lockfile, 'utf8')) + '\n');
  expect(await prepare('first')).toBe(first);
  expect(await inode(first, dependency)).not.toBe(old);
  expect(await inode(second, dependency)).toBe(old);
}, 30_000);
