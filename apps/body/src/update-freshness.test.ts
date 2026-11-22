import { compareBundleIdentity } from './self-update-manifest.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareLatestRelease, requiredBundlePaths, readUpdateState, writeUpdateState } from './self-update.js';
import { ReleaseTransaction } from './managed-update.js';

it.each([false, true])('repairs with the active newer release when force=%s and publication is older', async force => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-freshness-'));
  const layout = { libDir: join(root, 'lib/beeline'), releasesRoot: join(root, 'lib/beeline-releases'), binDir: join(root, 'bin') };
  await mkdir(join(layout.releasesRoot, 'new/lib/beeline'), { recursive: true });
  await writeFile(join(layout.releasesRoot, 'new/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.2.3' }));
  await symlink(join(layout.releasesRoot, 'new'), layout.libDir);
  const fetchImpl = vi.fn();
  const logger = vi.fn();
  try {
    const target = await prepareLatestRelease(layout, { force, fetchImpl, logger,
      manifest: { url: 'http://fixture/manifest.json', bundle: { version: 'v1.2.3-rc.2', file: 'old.tar.gz', sha256: 'a'.repeat(64) } } });
    expect(target.releaseId).toBe('new');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('already on v1.2.3'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('verifies different bytes at the same version and stages force repairs separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-content-repair-'));
  const layout = { libDir: join(root, 'lib/beeline'), releasesRoot: join(root, 'lib/beeline-releases'), binDir: join(root, 'bin') };
  const fixture = join(root, 'fixture');
  for (const file of requiredBundlePaths()) {
    await mkdir(dirname(join(fixture, file)), { recursive: true });
    await writeFile(join(fixture, file), file.endsWith('beeline-cli.mjs') ? 'console.log("fixture")' : 'fixture');
  }
  await writeFile(join(fixture, 'lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.2.3', commit: 'same' }));
  const archive = join(root, 'bundle.tar.gz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', fixture, '.']);
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(layout.releasesRoot, 'same/lib/beeline'), { recursive: true });
  await writeFile(join(layout.releasesRoot, 'same/.stage-ok'), 'a'.repeat(64));
  await writeFile(join(layout.releasesRoot, 'same/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.2.3', commit: 'same' }));
  await symlink(join(layout.releasesRoot, 'same'), layout.libDir);
  const manifest = { url: 'http://fixture/manifest.json', bundle: { file: 'bundle.tar.gz', version: 'v1.2.3', commit: 'same', sha256 } };
  try {
    const target = await prepareLatestRelease(layout, { manifest, fetchImpl: async () => new Response(bytes), logger: () => {} });
    expect(target.releaseId).not.toBe('same');
    expect((await readFile(join(layout.releasesRoot, target.releaseId, '.stage-ok'), 'utf8')).trim()).toBe(sha256);
    const repair = await prepareLatestRelease(layout, { manifest, force: true, fetchImpl: async () => new Response(bytes), logger: () => {} });
    expect(repair.releaseId).toContain('repair');
    expect(repair.releaseId).not.toBe(target.releaseId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not clear another writer\'s staging when an obsolete request is observed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-staging-writer-'));
  const layout = { libDir: join(root, 'lib'), releasesRoot: join(root, 'releases'), binDir: join(root, 'bin') };
  for (const [id, version] of [['old', 'v1.0.0'], ['live', 'v2.0.0']]) {
    await mkdir(join(layout.releasesRoot, id!, 'lib/beeline'), { recursive: true });
    await writeFile(join(layout.releasesRoot, id!, 'lib/beeline/bundle.json'), JSON.stringify({ version }));
  }
  await writeUpdateState(layout, { stagedReleaseId: 'other-writer' });
  const transaction = new ReleaseTransaction({ layout, loadedRelease: 'live', env: {},
    handoff: vi.fn(), failed: vi.fn(), changed: vi.fn() });
  try {
    await transaction.prepared('old');
    expect((await readUpdateState(layout)).stagedReleaseId).toBe('other-writer');
  } finally { transaction.dispose(); await rm(root, { recursive: true, force: true }); }
});


it('reports an older rc publication as current for check, even with a different commit', () => {
  expect(compareBundleIdentity({ version: 'v1.2.3', commit: 'final' },
    { version: 'v1.2.3-rc.2', commit: 'rc', file: 'bundle.tar.gz', sha256: 'a'.repeat(64) })).toEqual({ kind: 'current' });
});
