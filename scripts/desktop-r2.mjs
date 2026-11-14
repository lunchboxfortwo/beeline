#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://downloads.usebeeline.app';
const BUCKET = 'beeline-downloads';
const INSTALLER = /^Beeline-.*\.(?:dmg|app\.tar\.gz|AppImage|deb|rpm|msi|exe)(?:\.sig)?$/;

// Keep the signed bytes and desktop version when carrying a previous build.
// Only the download locations move to this release's immutable R2 prefix.
export function r2Manifest(manifest, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('R2 desktop tag must be vX.Y.Z');
  return {
    ...manifest,
    platforms: Object.fromEntries(Object.entries(manifest.platforms).map(([platform, entry]) => {
      const file = basename(new URL(entry.url).pathname);
      if (!INSTALLER.test(file)) throw new Error(`Invalid desktop updater asset: ${file}`);
      return [platform, { ...entry, url: `${ORIGIN}/${tag}/${file}` }];
    })),
  };
}

export async function publishDesktopR2({ directory, manifestPath, tag, output,
  token = process.env.CLOUDFLARE_R2_TOKEN, accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  fetchImpl = fetch }) {
  if (!token) throw new Error('CLOUDFLARE_R2_TOKEN is required for desktop publication');
  if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID');
  const manifest = r2Manifest(JSON.parse(await readFile(manifestPath, 'utf8')), tag);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && INSTALLER.test(entry.name)).map(entry => entry.name).sort();
  // Existing manifests already require a signed payload per platform. Make sure
  // every referenced byte set is among the installers being copied.
  for (const entry of Object.values(manifest.platforms)) {
    const file = basename(new URL(entry.url).pathname);
    if (!files.includes(file) || !files.includes(`${file}.sig`)) throw new Error(`Missing desktop payload or signature: ${file}`);
  }
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  const put = async (prefix, file, path) => {
    const key = `${prefix}/${encodeURIComponent(file)}`;
    const body = createReadStream(path);
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/objects/${key}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`,
          'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': String((await stat(path)).size) },
        body, duplex: 'half',
      });
      if (!response.ok) throw new Error(`R2 upload failed for ${prefix}/${file}: HTTP ${response.status}`);
      const result = await response.json();
      if (result.success !== true) throw new Error(`R2 upload failed for ${prefix}/${file}`);
    } finally { body.destroy(); }
  };
  // Finish the immutable set first, then advance latest. The latest manifest
  // is last so an updater never observes a reference to an unfinished upload.
  for (const prefix of [tag, 'latest']) {
    for (const file of files) await put(prefix, file, join(directory, file));
    await put(prefix, 'Beeline-latest.json', output);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) =>
    [process.argv[2 + i * 2].slice(2), process.argv[3 + i * 2]]));
  publishDesktopR2({ directory: args.directory, manifestPath: args.manifest, tag: args.tag, output: args.output })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
