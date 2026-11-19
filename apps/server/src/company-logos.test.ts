import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn(), agents: [] as any[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({
  Agent: class { constructor(options: unknown) { mocks.agents.push(options); } destroy() {} }, get: mocks.get,
}));
import { companyLogo, homepageIconUrl, publicIconResponse, readCompanyLogo, sizeCompanyLogo } from './company-logos.js';
import { COMPANY_MARK_IDS } from './company-registry.js';
beforeEach(() => { vi.clearAllMocks(); mocks.agents.length = 0; mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
afterEach(() => vi.restoreAllMocks());
function response(body: Buffer | string, mime = 'image/png', status = 200, location?: string) {
  mocks.get.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter(); const res = Object.assign(new EventEmitter(), { headers: { 'content-type': mime, location }, statusCode: status });
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
  it('projects only valid homepage URLs and upgrades bare or HTTP websites to HTTPS', () => {
    expect(homepageIconUrl('grunt.run', 'https://api')).toBe('https://api/v1/company-logos/https%3A%2F%2Fgrunt.run%2F');
    expect(homepageIconUrl('http://grunt.run/docs/#hi', 'https://api')).toBe('https://api/v1/company-logos/https%3A%2F%2Fgrunt.run%2Fdocs%2F');
    for (const homepage of [undefined, '', 'https://user:pass@grunt.run', 'https://grunt.run:8443', 'file:///tmp/icon', 'https://127.0.0.1'])
      expect(homepageIconUrl(homepage, 'https://api')).toBeUndefined();
  });
});
