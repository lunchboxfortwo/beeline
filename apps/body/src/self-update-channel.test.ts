import { describe, expect, it, vi } from 'vitest';
import { ReleaseTransaction } from './managed-update.js';
import { readPublishedBundle } from './self-update-manifest.js';

const distTagsUrl = 'https://registry.npmjs.org/-/package/usebeeline/dist-tags';
const platform = 'linux-x64';
const bundle = { file: 'beeline-linux-x64.tar.gz', sha256: 'a'.repeat(64) };

describe('helper release channels', () => {
  it.each([
    [undefined, 'v0.1.248-rc.2'],
    ['latest', 'v0.1.248-rc.2'],
    [' next ', 'v0.1.249-rc.1'],
  ])('resolves channel %s to the exact npm version %s', async (channel, version) => {
    const url = `https://downloads.usebeeline.app/dl/releases/${version}/manifest.json`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ latest: '0.1.248-rc.2', next: '0.1.249-rc.1' }))
      .mockResolvedValueOnce(Response.json({ version, bundles: { [platform]: bundle } }));
    await expect(readPublishedBundle(platform, {
      fetchImpl, env: { BEELINE_RELEASE_CHANNEL: channel },
    })).resolves.toEqual({ url, bundle: { ...bundle, version } });
    expect(fetchImpl.mock.calls.map(([request]) => request)).toEqual([distTagsUrl, url]);
  });

  it('only fetches the explicit manifest override', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ bundles: { [platform]: bundle } }));
    const url = 'https://lab.test/manifest.json';
    await expect(readPublishedBundle(platform, {
      fetchImpl, env: { BEELINE_RELEASE_CHANNEL: 'next', BEELINE_UPDATE_MANIFEST_URL: ` ${url} ` },
    })).resolves.toEqual({ url, bundle });
    expect(fetchImpl.mock.calls.map(([request]) => request)).toEqual([url]);
  });

  it('rejects an unknown channel before fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(readPublishedBundle(platform, {
      fetchImpl, env: { BEELINE_RELEASE_CHANNEL: 'nxet' },
    })).rejects.toThrow('invalid helper release channel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, '../0.1.248', 'latest'])('rejects invalid registry tag target %s', async (next) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ latest: '0.1.248-rc.2', next }));
    await expect(readPublishedBundle(platform, {
      fetchImpl, env: { BEELINE_RELEASE_CHANNEL: 'next' },
    })).rejects.toThrow('no valid helper version');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a manifest with a different release version', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ latest: '0.1.248-rc.2' }))
      .mockResolvedValueOnce(Response.json({ version: 'v0.1.247', bundles: { [platform]: bundle } }));
    await expect(readPublishedBundle(platform, { fetchImpl, env: {} })).rejects.toThrow('does not match npm version');
  });

  it('preserves the build identity of a Mac bundle carried into the selected release', async () => {
    const carriedBundle = {
      file: 'beeline-darwin-arm64.tar.gz',
      version: 'v0.1.247-rc.1',
      commit: 'b'.repeat(40),
      sha256: bundle.sha256,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ latest: '0.1.248-rc.2' }))
      .mockResolvedValueOnce(Response.json({
        version: 'v0.1.248-rc.2',
        bundles: { 'darwin-arm64': { ...carriedBundle, carriedFrom: carriedBundle } },
      }));
    await expect(readPublishedBundle('darwin-arm64', { fetchImpl, env: {} })).resolves.toEqual({
      url: 'https://downloads.usebeeline.app/dl/releases/v0.1.248-rc.2/manifest.json',
      bundle: carriedBundle,
    });
  });
});


it('rechecks a promoted channel even when the build identity was already announced by next', async () => {
  const prepare = vi.fn(async () => {});
  const update = new ReleaseTransaction({
    // No real install, network, native manager, or update worker participates.
    layout: { libDir: '/unavailable-beeline-test/lib', binDir: '/unavailable-beeline-test/bin', releasesRoot: '/unavailable-beeline-test/releases' },
    env: {}, prepare, idle: () => true,
    handoff: vi.fn(), changed: vi.fn(), failed: vi.fn(),
  });
  update.notify('v0.1.2:next-sha');
  await update.pending;
  update.notify('v0.1.2:next-sha');
  await update.pending;
  expect(prepare).toHaveBeenCalledTimes(2);
});
