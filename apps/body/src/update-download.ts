import { progress } from './update-progress.js';
import { ask } from './wait.js';

/** Every chunk is reported; a stalled download ends on the transport's own read failure. */
export async function downloadBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: { report?: (line: string) => void } = {},
): Promise<Uint8Array> {
  const report = options.report ?? progress;
  let step = `network DNS/connect/headers ${url}`;
  try {
    const response = await ask({ url, fetch: fetchImpl, report });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('missing response body');
    step = `network body ${url} (0 bytes)`;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const value = new Uint8Array(chunk);
      chunks.push(value);
      bytes += value.byteLength;
      step = `network body ${url} (${bytes} bytes)`;
      report(step);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    throw new Error(`${step}: ${String(error)}${cause ? ` (${cause})` : ''}`);
  }
}
