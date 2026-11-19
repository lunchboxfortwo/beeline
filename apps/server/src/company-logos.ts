import { lookup } from 'node:dns/promises';
import { Agent, get } from 'node:https';
import { readFileSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import type { CompanyLogo } from '@beeline/api-contract/workbench';
import { COMPANY_MARK_IDS, companyHost, type CompanyProvider } from './company-registry.js';

type Image = { bytes: Buffer; mime: string };
const cache = new Map<string, { until: number; image?: Image; pending?: Promise<Image | undefined> }>();
const LIMIT = 512 * 1024;
let fetching = 0;

export function companyLogo(provider: CompanyProvider, origin: string): CompanyLogo {
  if (!provider.domain) return { kind: 'monogram' };
  const id = COMPANY_MARK_IDS.has(provider.id) ? provider.id : provider.domain;
  return { kind: 'image', uri: `${origin}/v1/company-logos/${encodeURIComponent(id)}`,
    plate: COMPANY_MARK_IDS.has(provider.id) ? 'dark' : 'light' };
}
function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    return ip.range() === 'unicast' && (ip.kind() === 'ipv4' ||
      (ip.match(ipaddr.parseCIDR('2000::/3')) && !ip.match(ipaddr.parseCIDR('2001:db8::/32'))));
  } catch { return false; }
}
/** Resolve once and pin the HTTPS socket; redirects resolve and validate independently. */
export async function publicIconResponse(url: URL, redirects = 0, deadline = Date.now() + 10_000): Promise<{ bytes: Buffer; mime: string; url: URL }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !companyHost(url.hostname) || redirects > 3)
    throw new Error('invalid company icon address');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('company icon timeout');
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => !publicAddress(a.address))) throw new Error('non-public company icon');
  const address = answers[0]!;
  const agent = new Agent({ autoSelectFamily: false, lookup(hostname, _options, callback) {
    if (hostname !== url.hostname) return callback(new Error('icon hostname mismatch'), '', 4);
    callback(null, address.address, address.family);
  } });
  try {
    const response = await new Promise<{ bytes: Buffer; mime: string; location?: string; status: number }>((resolve, reject) => {
      const req = get(url, { agent, timeout: remaining, headers: { accept: 'image/*,text/html;q=0.5', 'user-agent': 'Beeline company icons' } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        const mime = (res.headers['content-type'] ?? '').split(';')[0]!;
        const done = () => resolve({ bytes: Buffer.concat(chunks), mime, status: res.statusCode ?? 500, location: res.headers.location });
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= LIMIT) chunks.push(chunk);
          // A large homepage still declares its icons in the head, which is inside the first LIMIT bytes.
          else if (mime === 'text/html') { chunks.push(chunk.subarray(0, LIMIT - size + chunk.length)); done(); req.destroy(); }
          else req.destroy(new Error('company icon too large'));
        });
        res.on('error', reject);
        res.on('end', done);
      });
      req.on('timeout', () => req.destroy(new Error('company icon timeout')));
      req.on('error', reject);
    });
    if (response.status >= 300 && response.status < 400 && response.location)
      return publicIconResponse(new URL(response.location, url), redirects + 1, deadline);
    if (response.status !== 200) throw new Error('company icon unavailable');
    return { bytes: response.bytes, mime: response.mime, url };
  } finally { agent.destroy(); }
}
function homepageUrl(value: string): URL | undefined {
  try {
    if (value.length > 2048) return undefined;
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || !companyHost(value) || url.username || url.password || url.port) return undefined;
    url.protocol = 'https:';
    url.hash = '';
    return url;
  } catch { return undefined; }
}

/** Use the existing safe icon endpoint; Room reads never wait on a website. */
export function homepageIconUrl(homepage: string | null | undefined, origin: string): string | undefined {
  const url = homepage ? homepageUrl(homepage) : undefined;
  return url ? `${origin}/v1/company-logos/${encodeURIComponent(url.href)}` : undefined;
}

/** Raw RGBA from a Windows icon's largest entry (sharp reads PNG entries but not .ico files). */
function icoImage(bytes: Buffer): sharp.Sharp | undefined {
  if (bytes.length < 22 || bytes.readUInt32BE(0) !== 0x00000100) return undefined;
  let best: { size: number; entry: Buffer } | undefined;
  for (let i = 0, at = 6; i < bytes.readUInt16LE(4) && at + 16 <= bytes.length; i++, at += 16) {
    const size = bytes[at] || 256;
    if (!best || size > best.size) best = { size, entry: bytes.subarray(bytes.readUInt32LE(at + 12), bytes.readUInt32LE(at + 12) + bytes.readUInt32LE(at + 8)) };
  }
  const entry = best?.entry;
  if (!entry || entry.length < 40) return undefined;
  if (entry.readUInt32BE(0) === 0x89504e47) return sharp(entry, { limitInputPixels: 1_000_000 });
  const header = entry.readUInt32LE(0), width = entry.readInt32LE(4), height = entry.readInt32LE(8) / 2, bpp = entry.readUInt16LE(14);
  if (!(width >= 1 && width <= 256 && height >= 1 && height <= 256) || ![1, 4, 8, 24, 32].includes(bpp)) return undefined;
  const palette = header, pixels = header + (bpp <= 8 ? (entry.readUInt32LE(32) || 1 << bpp) * 4 : 0);
  const stride = ((width * bpp + 31) >> 5) * 4, maskStride = ((width + 31) >> 5) * 4, mask = pixels + stride * height;
  if (mask + maskStride * height > entry.length) return undefined;
  const data = Buffer.alloc(width * height * 4);
  let alpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - 1 - y) * stride, maskRow = mask + (height - 1 - y) * maskStride;
    for (let x = 0; x < width; x++) {
      let color = row + x * (bpp >> 3);
      if (bpp <= 8) color = palette + ((entry[row + ((x * bpp) >> 3)]! >> (8 - bpp - ((x * bpp) & 7))) & ((1 << bpp) - 1)) * 4;
      const out = (y * width + x) * 4;
      data[out] = entry[color + 2] ?? 0; data[out + 1] = entry[color + 1] ?? 0; data[out + 2] = entry[color] ?? 0;
      data[out + 3] = bpp === 32 ? entry[row + x * 4 + 3]! : (entry[maskRow + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
      if (bpp === 32 && data[out + 3]) alpha = true;
    }
  }
  // Old 32-bit icons leave alpha empty and draw their shape with the 1-bit mask.
  if (bpp === 32 && !alpha) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    data[(y * width + x) * 4 + 3] = (entry[mask + (height - 1 - y) * maskStride + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
  return sharp(data, { raw: { width, height, channels: 4 } });
}

async function siteIcon(homepage: URL): Promise<Image | undefined> {
  const urls: URL[] = [];
  const deadline = Date.now() + 10_000;
  try {
    const page = await publicIconResponse(homepage, 0, deadline);
    if (page.mime === 'text/html') {
      const html = page.bytes.toString('utf8');
      for (const tag of html.match(/<link\b[^>]{0,2048}>/gi) ?? []) {
        const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (rel?.split(/\s+/).some(r => r.toLowerCase() === 'icon' || r.toLowerCase() === 'apple-touch-icon') && href) {
          try { urls.push(new URL(href.replace(/&amp;/g, '&'), page.url)); } catch { /* invalid site metadata */ }
        }
        if (urls.length >= 3) break;
      }
    }
  } catch { /* root unavailable; still try the conventional site icon */ }
  urls.push(new URL('/favicon.ico', homepage));
  for (const url of urls.slice(0, 4)) {
    try {
      const image = await publicIconResponse(url, 0, deadline);
      if (!image.mime.startsWith('image/')) continue;
      const bytes = await (icoImage(image.bytes) ?? sharp(image.bytes, { limitInputPixels: 1_000_000, animated: false }))
        .resize(64, 64, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      return { bytes, mime: 'image/png' };
    } catch { /* try the next site-provided icon */ }
  }
  return undefined;
}
/** Bounded process cache; icon IO never runs as part of the Workbench DTO read. */
export async function readCompanyLogo(id: string): Promise<Image | undefined> {
  if (COMPANY_MARK_IDS.has(id)) {
    const held = cache.get(id)?.image;
    if (held) return held;
    const bytes = await sharp(readFileSync(new URL(`../assets/companies/${id}.svg`, import.meta.url))).resize(64, 64, { fit: 'inside' }).png().toBuffer();
    const image = { bytes, mime: 'image/png' };
    cache.set(id, { until: Infinity, image }); return image;
  }
  const homepage = homepageUrl(id);
  if (!homepage || (!id.includes('://') && (homepage.hostname !== id || id.length > 253))) return undefined;
  // Domain-based Workbench logos and repository homepages share one cache.
  const key = homepage.href;
  const held = cache.get(key);
  if (held && held.until > Date.now()) return held.pending ?? held.image;
  if (fetching >= 4) return undefined;
  if (cache.size >= 512) { for (const key of cache.keys()) { if (!COMPANY_MARK_IDS.has(key) && !cache.get(key)?.pending) { cache.delete(key); break; } } }
  fetching++;
  const pending = siteIcon(homepage).then(image => { cache.set(key, { image, until: Date.now() + (image ? 10 * 60_000 : 60_000) }); return image; })
    .finally(() => { fetching--; });
  cache.set(key, { until: Infinity, pending });
  return pending;
}

/** Native requests physical pixels so Image can display pixel art without resampling. */
export async function sizeCompanyLogo(image: Image, size: string | null): Promise<Image> {
  const pixels = Number(size);
  if (!Number.isInteger(pixels) || pixels < 1 || pixels > 512) return image;
  return { bytes: await sharp(image.bytes).resize(pixels, pixels, { fit: 'contain', kernel: 'nearest',
    background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), mime: 'image/png' };
}
