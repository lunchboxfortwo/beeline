import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn(), agents: [] as any[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({
  Agent: class { constructor(options: unknown) { mocks.agents.push(options); } destroy() {} }, get: mocks.get,
}));
import { companyLogo, publicIconResponse, readCompanyLogo, extractIconHref, pickRepositoryIconPath, resolveHomepageIcon, resolveRepositoryIcon, sizeCompanyLogo } from './company-logos.js';
import { COMPANY_MARK_IDS } from './company-registry.js';
beforeEach(() => { vi.clearAllMocks(); mocks.agents.length = 0; mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
afterEach(() => vi.restoreAllMocks());
function response(body: Buffer | string, mime = 'image/png', status = 200, location?: string) {
  mocks.get.mockImplementationOnce((_url, _options, callback) => {
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() }); const res = Object.assign(new EventEmitter(), { headers: { 'content-type': mime, location }, statusCode: status });
    queueMicrotask(() => { callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); }); return req;
  });
}
describe('server company logos', () => {
  it('serves every built-in mark from its shipped asset without external IO', async () => {
    for (const id of COMPANY_MARK_IDS) { const icon = await readCompanyLogo(id); expect(icon?.mime).toBe('image/png'); expect((await sharp(icon!.bytes).metadata()).width).toBe(64); }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(companyLogo({ id: 'sentry', name: 'Sentry', domain: 'sentry.io', hosts: [] }, 'https://api')).toMatchObject({ kind: 'image', uri: 'https://api/v1/company-logos/sentry' });
    expect(companyLogo({ id: 'other', name: 'Other', hosts: [] }, '')).toEqual({ kind: 'monogram' });
  });
  it('rejects private, loopback, link-local, mapped and mixed DNS answers before opening a socket', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:db8::1']) {
      mocks.lookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(publicIconResponse(new URL('https://site.example/icon'))).rejects.toThrow('non-public');
    }
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }]);
    await expect(publicIconResponse(new URL('https://site.example/icon'))).rejects.toThrow('non-public'); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('rejects protocols, ports, credentials, IP literals and exhausted deadlines', async () => {
    for (const url of ['http://site.example/icon', 'https://site.example:444/icon', 'https://user:pass@site.example/icon', 'https://127.0.0.1/icon'])
      await expect(publicIconResponse(new URL(url))).rejects.toThrow('invalid');
    await expect(publicIconResponse(new URL('https://site.example'), 0, Date.now() - 1)).rejects.toThrow('timeout'); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('pins vetted DNS and independently rejects a private redirect destination', async () => {
    response('', 'text/html', 302, 'https://internal.example/icon'); mocks.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(publicIconResponse(new URL('https://site.example'))).rejects.toThrow('non-public');
    const callback = vi.fn(); mocks.agents[0].lookup('site.example', {}, callback); expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4); expect(mocks.get).toHaveBeenCalledTimes(1);
  });
  it('discovers the company icon, rasterizes it, coalesces requests and caches the result', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
    response('<link rel="icon" href="/mark.png">', 'text/html'); response(png);
    const [a, b] = await Promise.all([readCompanyLogo('fresh.example'), readCompanyLogo('fresh.example')]);
    expect(a?.mime).toBe('image/png'); expect(a).toBe(b); expect(await readCompanyLogo('fresh.example')).toBe(a); expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1]?.[0].pathname).toBe('/mark.png');
  });
  it('reads icon links from the head of a homepage larger than the read limit', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
    response(`<link rel="icon" href="/big.png">${' '.repeat(600 * 1024)}`, 'text/html'); response(png);
    const icon = await readCompanyLogo('large-home.example');
    expect(icon?.mime).toBe('image/png'); expect(mocks.get.mock.calls[1]?.[0].pathname).toBe('/big.png');
  });
  it('decodes a Windows icon from the conventional favicon.ico', async () => {
    // One 2x2 8-bit entry: palette [transparent, red], top row red, bottom row masked out.
    const bmp = Buffer.alloc(40 + 256 * 4 + 2 * 4 + 2 * 4);
    bmp.writeUInt32LE(40, 0); bmp.writeInt32LE(2, 4); bmp.writeInt32LE(4, 8); bmp.writeUInt16LE(1, 12); bmp.writeUInt16LE(8, 14);
    bmp.writeUInt32LE(0x00ff0000, 40 + 4);
    const pixels = 40 + 256 * 4; bmp[pixels + 4] = 1; bmp[pixels + 5] = 1; bmp[pixels + 8] = 0xc0;
    const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 2; ico[7] = 2;
    ico.writeUInt32LE(bmp.length, 14); ico.writeUInt32LE(22, 18);
    response('<html></html>', 'text/html'); response(Buffer.concat([ico, bmp]), 'image/x-icon');
    const icon = await readCompanyLogo('ico-only.example');
    expect(mocks.get.mock.calls[1]?.[0].pathname).toBe('/favicon.ico');
    const { data } = await sharp(icon!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([...data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('expires missing site icons after one minute', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await readCompanyLogo('expiry-miss.example')).toBeUndefined();
    const calls = mocks.lookup.mock.calls.length;
    clock.mockReturnValue(1_059_999);
    expect(await readCompanyLogo('expiry-miss.example')).toBeUndefined();
    expect(mocks.lookup).toHaveBeenCalledTimes(calls);
    clock.mockReturnValue(1_060_000);
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    response('<link rel="icon" href="favicon.svg">', 'text/html');
    response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#fff" d="M0 0h16v16H0z"/></svg>', 'image/svg+xml');
    expect((await readCompanyLogo('expiry-miss.example'))?.mime).toBe('image/png');
    expect(mocks.lookup.mock.calls.length).toBeGreaterThan(calls);
  });
  it('negative-caches unavailable site icons without issuing repeated requests', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await readCompanyLogo('unavailable.example')).toBeUndefined(); const calls = mocks.lookup.mock.calls.length;
    expect(await readCompanyLogo('unavailable.example')).toBeUndefined(); expect(mocks.lookup).toHaveBeenCalledTimes(calls);
    expect(await readCompanyLogo('../sentry')).toBeUndefined();
  });
});

describe('repository homepage icons', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#fff" d="M0 0h8v16H0z"/><path fill="#000" d="M8 0h8v16H8z"/></svg>';
  it('uses the homepage path and its relative SVG icon, converted for native Image', async () => {
    response('<link rel="icon" href="favicon.svg">', 'text/html');
    response(svg, 'image/svg+xml');
    const icon = await readCompanyLogo('https://project.example/docs/');
    expect(mocks.get.mock.calls.map(call => call[0].href)).toEqual([
      'https://project.example/docs/', 'https://project.example/docs/favicon.svg',
    ]);
    expect(icon?.mime).toBe('image/png');
    expect((await sharp(icon!.bytes).metadata()).width).toBe(16);
    const native = await sizeCompanyLogo(icon!, '108');
    expect((await sharp(native.bytes).metadata()).width).toBe(108);
    const { data, info } = await sharp(native.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const colors = new Set<string>();
    for (let offset = 0; offset < data.length; offset += info.channels) colors.add(data.subarray(offset, offset + info.channels).toString('hex'));
    expect(colors).toEqual(new Set(['ffffffff', '000000ff']));
  });
  it('resolves a repository homepage\'s site icon as the stored 64 px chat picture, uncached', async () => {
    response('<link rel="icon" href="/favicon.svg">', 'text/html'); response(svg, 'image/svg+xml');
    const icon = await resolveHomepageIcon('grunt.example');
    expect(mocks.get.mock.calls.map(call => call[0].href)).toEqual(['https://grunt.example/', 'https://grunt.example/favicon.svg']);
    expect(icon?.path).toBe('https://grunt.example/');
    expect(await sharp(icon!.image.bytes).metadata()).toMatchObject({ format: 'png', width: 64, height: 64 });
    response('', 'text/html', 404); response('', 'text/html', 404);
    expect(await resolveHomepageIcon('https://grunt.example')).toBeUndefined();
    expect(mocks.get).toHaveBeenCalledTimes(4);
    expect(await resolveHomepageIcon('http://127.0.0.1/')).toBeUndefined();
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });
  it('shares normalized homepage hits for ten minutes, then fetches again', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    response('<link rel="apple-touch-icon" href="/icon.svg">', 'text/html'); response(svg, 'image/svg+xml');
    const icon = await readCompanyLogo('shared-cache.example');
    clock.mockReturnValue(2_599_999);
    expect(await readCompanyLogo('https://shared-cache.example/')).toBe(icon);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(2_600_000);
    response('<link rel="icon" href="/new.svg">', 'text/html'); response(svg, 'image/svg+xml');
    expect(await readCompanyLogo('https://shared-cache.example/')).not.toBe(icon);
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });
});

describe('repository icon files', () => {
  const square = (width: number, height = width) => sharp({ create: { width, height, channels: 4, background: '#123456' } }).png().toBuffer();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#fff" d="M0 0h16v16H0z"/></svg>';
  function repository(files: Record<string, Buffer | string>) {
    const paths = Object.keys(files);
    return vi.fn(async (path: string) => {
      if (path.startsWith('git/trees/')) return { tree: [{ path: 'public', type: 'tree', sha: 'dir' },
        ...paths.map((file, index) => ({ path: file, type: 'blob', sha: `sha${index}` }))] };
      const file = paths[Number(path.slice('git/blobs/sha'.length))]!;
      return { content: Buffer.from(files[file]!).toString('base64'), encoding: 'base64' };
    });
  }
  const pick = (files: string[], sources: Record<string, string> = {}) => {
    const read = vi.fn(async (path: string) => sources[path]);
    return { read, path: pickRepositoryIconPath(new Set(files), read) };
  };
  it('follows t3code: its well-known paths in order, first existing file wins, no image comparison', async () => {
    expect(await pick(['assets/logo.png', 'src/favicon.ico', 'public/favicon.png', 'favicon.ico', 'app/icon.svg']).path).toBe('favicon.ico');
    expect(await pick(['assets/logo.png', 'src/favicon.ico', 'app/icon.svg', '.idea/icon.svg']).path).toBe('app/icon.svg');
    expect(await pick(['.idea/icon.svg', 'assets/logo.svg']).path).toBe('assets/logo.svg');
    // Names outside the list never count, whatever their size or depth.
    expect(await pick(['icon-512.png', 'apple-touch-icon.png', 'logo.png', 'docs/favicon.svg', 'favicon.gif']).path).toBeUndefined();
  });
  it('else uses the first icon link in its source files, resolved against public/ then the root', async () => {
    const html = (href: string) => `<head><link rel="manifest" href="/m.json"><link href="${href}" rel="shortcut icon"></head>`;
    expect(await pick(['index.html', 'public/brand/mark.svg', 'brand/mark.svg'], { 'index.html': html('/brand/mark.svg?v=2') }).path).toBe('public/brand/mark.svg');
    expect(await pick(['index.html', 'brand/mark.svg'], { 'index.html': html(' brand/mark.svg') }).path).toBe('brand/mark.svg');
    // A TanStack root route's head object, after an HTML source whose link names a missing file.
    const route = "head: () => ({ links: [{ rel: 'stylesheet', href: '/app.css' }, { rel: 'icon', href: '/mark.png' }] })";
    const { read, path } = pick(['index.html', 'src/routes/__root.tsx', 'public/mark.png'], { 'index.html': html('/gone.svg'), 'src/routes/__root.tsx': route });
    expect(await path).toBe('public/mark.png');
    expect(read.mock.calls.map(([source]) => source)).toEqual(['index.html', 'src/routes/__root.tsx']);
    // A link may not leave the project.
    expect(await pick(['index.html', 'secret.svg'], { 'index.html': html('../../secret.svg') }).path).toBeUndefined();
    expect(extractIconHref('<link rel="apple-touch-icon" href="/a.png">')).toBeUndefined();
  });
  it('searches each apps/*/ then packages/*/ directory only when the root yields nothing (the one step past t3)', async () => {
    expect(await pick(['packages/ui/favicon.svg', 'apps/web/public/favicon.svg', 'apps/api/src/index.ts']).path).toBe('apps/web/public/favicon.svg');
    expect(await pick(['packages/ui/favicon.svg', 'apps/web/src/main.ts']).path).toBe('packages/ui/favicon.svg');
    expect(await pick(['favicon.png', 'apps/web/favicon.svg']).path).toBe('favicon.png');
    expect(await pick(['apps/web/index.html', 'apps/web/public/mark.svg', 'apps/zzz/favicon.svg'], { 'apps/web/index.html': '<link rel="icon" href="/mark.svg">' }).path)
      .toBe('apps/web/public/mark.svg');
  });
  it('picks for today\'s repositories: beeline, trusty-squire and testatlas get icons; grunt and amazing-adventure none', async () => {
    const beeline = pick(['README.md', 'apps/mobile/logo.png', 'apps/mobile/public/icon-512.png', 'apps/mobile/public/favicon-active.ico',
      'apps/mobile/public/index.html', 'apps/mobile/sources/assets/images/icon.svg', 'apps/site/apple-touch-icon.png', 'apps/site/favicon.ico',
      'apps/site/icon-512.png', 'apps/site/index.html'], { 'apps/mobile/public/index.html': '<link rel="manifest" href="/site.webmanifest">' });
    expect(await beeline.path).toBe('apps/site/favicon.ico');
    expect(await pick(['apps/web/public/favicon.svg', 'apps/web/public/logo.svg']).path).toBe('apps/web/public/favicon.svg');
    expect(await pick(['public/favicon.svg', 'src/app.tsx']).path).toBe('public/favicon.svg');
    expect(await pick(['site/favicon.svg', 'site/index.html', 'src/chat.html']).path).toBeUndefined();
    expect(await pick(['README.md', 'src/main.ts']).path).toBeUndefined();
  });
  it('reads one tree and only the picked file, storing it at 64 px', async () => {
    const read = repository({ 'README.md': 'hi', 'assets/logo.png': await square(180), 'favicon.png': await square(32, 16) });
    const icon = await resolveRepositoryIcon('main', read);
    expect(read.mock.calls.map(([path]) => path)).toEqual(['git/trees/main?recursive=1', 'git/blobs/sha2']);
    expect(icon?.path).toBe('favicon.png');
    expect(await sharp(icon!.image.bytes).metadata()).toMatchObject({ width: 64, height: 64 });
    // testatlas's committed favicon.svg is 64x60; it is padded into the 64 px square.
    const wide = await resolveRepositoryIcon('main', repository({ 'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 60"><path d="M0 0h64v60H0z"/></svg>' }));
    expect(await sharp(wide!.image.bytes).metadata()).toMatchObject({ width: 64, height: 64 });
  });
  it('reads a committed favicon.ico through its largest entry', async () => {
    const png = await square(32);
    // A 2x2 32-bit entry with its 1-bit mask rows, then the larger PNG entry.
    const bmp = Buffer.alloc(40 + 2 * 2 * 4 + 2 * 4); bmp.writeUInt32LE(40, 0); bmp.writeInt32LE(2, 4); bmp.writeInt32LE(4, 8); bmp.writeUInt16LE(1, 12); bmp.writeUInt16LE(32, 14);
    for (let offset = 40; offset < 56; offset += 4) bmp.set([0x00, 0x00, 0xff, 0xff], offset);
    const header = Buffer.alloc(6 + 32); header.writeUInt16LE(1, 2); header.writeUInt16LE(2, 4);
    header[6] = 2; header.writeUInt32LE(bmp.length, 14); header.writeUInt32LE(38, 18);
    header[22] = 32; header.writeUInt32LE(png.length, 30); header.writeUInt32LE(38 + bmp.length, 34);
    const icon = await resolveRepositoryIcon('main', repository({ 'favicon.ico': Buffer.concat([header, bmp, png]) }));
    // The 32 px PNG entry (#123456), not the 2 px red bitmap, scaled to the stored 64 px.
    const { data, info } = await sharp(icon!.image.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(64);
    expect([...data.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56]);
  });
  it('finds no icon when the tree has none or the file is not an image, and surfaces a refused tree read so nothing is stored', async () => {
    expect(await resolveRepositoryIcon('main', repository({ 'src/index.ts': 'x', 'favicon.gif': await square(32) }))).toBeUndefined();
    expect(await resolveRepositoryIcon('main', repository({ 'favicon.svg': 'not an image' }))).toBeUndefined();
    await expect(resolveRepositoryIcon('main', vi.fn(async () => { throw new Error('404'); }))).rejects.toThrow('404');
  });
});
