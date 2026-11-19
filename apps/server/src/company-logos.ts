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
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) req.destroy(new Error('company icon too large')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks), mime: (res.headers['content-type'] ?? '').split(';')[0]!,
          status: res.statusCode ?? 500, location: res.headers.location }));
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
      const bytes = await sharp(image.bytes, { limitInputPixels: 1_000_000, animated: false })
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
