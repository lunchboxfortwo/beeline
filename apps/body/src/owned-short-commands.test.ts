import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { namedPrivateFiles } from './read-only-mcp-download-attachment.js';
import { ownedCommandModule, runOwned } from './wait.js';
import { build } from 'esbuild';
import { fetchRepositoryCache } from './repository-cache-repair.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owned-short-commands-'));
  dirs.push(dir);
  return dir;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('short local commands run as owned children', () => {
  it("keeps git's stderr in a failed repository cache fetch", async () => {
    const source = scratch();
    git(source, 'init', '-q', '-b', 'main');
    git(
      source,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    );
    const gitDir = join(scratch(), 'cache.git');
    git(tmpdir(), 'init', '-q', '--bare', gitDir);
    await fetchRepositoryCache({
      gitDir,
      label: 'fixture',
      args: [source, '+refs/heads/main:refs/remotes/origin/main'],
    });
    const missing = fetchRepositoryCache({
      gitDir,
      label: 'fixture',
      args: [source, '+refs/heads/absent:refs/remotes/origin/absent'],
    });
    await expect(missing).rejects.toThrow(/couldn't find remote ref/i);
  });

  it('asks git which named relative files are tracked', async () => {
    const checkout = scratch();
    git(checkout, 'init', '-q', '-b', 'main');
    writeFileSync(join(checkout, 'tracked.txt'), 'tracked');
    writeFileSync(join(checkout, 'proof.txt'), 'untracked');
    git(checkout, 'add', 'tracked.txt');
    const found = await namedPrivateFiles([checkout], 'See tracked.txt and proof.txt', true);
    expect(found.map((file) => file.named)).toEqual(['proof.txt']);
  });
});

it('runs the standalone child owner emitted by a bundled helper', async () => {
  const bundled = await build({
    stdin: { contents: "export { ownedCommandModule } from './wait.ts';", resolveDir: __dirname },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20',
  });
  const result = await runOwned({
    step: 'bundled standalone owner', file: process.execPath,
    args: ['--input-type=module', '-e', bundled.outputFiles[0]!.text + `
      const { runOwned: runStandalone } = await import(ownedCommandModule());
      const result = await runStandalone({step:'fixture',file:process.execPath,args:['-e',"console.log('owned'); console.error('progress');"],machineRead:true});
      console.log(JSON.stringify(result));`],
    machineRead: true,
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: 0, stdout: 'owned\n', stderr: 'progress\n' });
});
