import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { prepareWorkspace } from './workspace-checkout.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
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

/** A repository whose first test run needs installed packages and built output. */
async function fixture(
  scripts: Record<string, string>,
  restore: { brief?: { spec: string } } = {},
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
  await exec(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: source },
  );
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
    prepare: (parentRoomId?: string) =>
      prepareWorkspace({
        api,
        config,
        supervisorRoot,
        workspaceId: 'workspace',
        agent: { name: 'Proof', publicKey: 'a'.repeat(64) },
        placeId: 'place',
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
