import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const BUCKET = 'beeline-downloads';

// Shared by desktop installers and mutable helper channels. Stream the exact
// validated file bytes; publication owns ordering and advances manifests last.
export function createR2Uploader({ token = process.env.CLOUDFLARE_R2_TOKEN,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('CLOUDFLARE_R2_TOKEN is required for R2 publication');
  if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID');
  return async (prefix, file, path) => {
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
}
