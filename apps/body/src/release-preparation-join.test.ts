import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareMachineRelease } from './recovery.js';
import { prepareLatestRelease, requiredBundlePaths } from './self-update.js';
import { tryLock } from './wait.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** An isolated install and one published bundle the owner and joiner both prepare. */
async function published() {
  const root = await mkdtemp(join(tmpdir(), 'beeline-preparation-join-'));
  roots.push(root);
  const layout = {
    libDir: join(root, 'lib/beeline'),
    releasesRoot: join(root, 'lib/beeline-releases'),
    binDir: join(root, 'bin'),
  };
  const fixture = join(root, 'fixture');
  for (const file of requiredBundlePaths()) {
    await mkdir(dirname(join(fixture, file)), { recursive: true });
    await writeFile(
      join(fixture, file),
      file.endsWith('beeline-cli.mjs') ? 'console.log("fixture")' : 'fixture',
    );
  }
  await writeFile(
    join(fixture, 'lib/beeline/bundle.json'),
    JSON.stringify({ version: 'v0.2.3', commit: '4'.repeat(40) }),
  );
  const archive = join(root, 'bundle.tar.gz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', fixture, '.']);
  const bytes = await readFile(archive);
  const bundle = {
    file: 'bundle.tar.gz',
    version: 'v0.2.3',
    commit: '4'.repeat(40),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return {
    layout,
    bytes,
    manifest: { url: 'http://fixture/manifest.json', bundle },
    key: `beeline-install:${resolve(layout.libDir)}`,
  };
}

it('joins the preparation the helper already runs for the same release', async () => {
  // Linux helper proof: `beeline update` right after a publish refused at once
  // with "release preparation already running as pid <helper's worker>".
  const { layout, bytes, manifest, key } = await published();
  const owner = await tryLock(key, { step: 'release preparation' });
  if (!owner.held) throw new Error('the owner could not take the install lock');
  let followed!: () => void;
  const following = new Promise<void>((done) => (followed = done));
  const logger = vi.fn((line: string) => {
    if (line.includes('following it')) followed();
  });
  const joinerFetch = vi.fn(async () => new Response(bytes));
  const joined = prepareMachineRelease(layout, { manifest, fetchImpl: joinerFetch, logger });
  // A refusal rejects here instead of leaving the test waiting.
  await Promise.race([following, joined]);
  expect(logger).toHaveBeenCalledWith(
    expect.stringMatching(
      /^release preparation already running as pid \d+ since .+; following it$/,
    ),
  );
  const prepared = await prepareLatestRelease(layout, {
    manifest,
    fetchImpl: async () => new Response(bytes),
    logger: () => {},
  });
  await owner.release();
  expect(await joined).toEqual(prepared);
  // The joiner reused the owner's verified staging rather than downloading again.
  expect(joinerFetch).not.toHaveBeenCalled();
});

it('still refuses other install work at once, naming its holder', async () => {
  const { layout, bytes, manifest, key } = await published();
  const owner = await tryLock(key, { step: 'release activation' });
  if (!owner.held) throw new Error('the owner could not take the install lock');
  try {
    await expect(
      prepareMachineRelease(layout, {
        manifest,
        fetchImpl: async () => new Response(bytes),
        logger: () => {},
      }),
    ).rejects.toThrow(/^release activation already running as pid \d+/);
  } finally {
    await owner.release();
  }
});
