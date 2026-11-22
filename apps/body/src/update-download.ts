import { progress } from './update-progress.js';

/** The inactivity budget resets on bytes, never on total download duration. */
export async function downloadBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: { idleMs?: number; report?: (line: string) => void } = {},
): Promise<Uint8Array> {
  const report = options.report ?? progress;
  const controller = new AbortController();
  let step = `network DNS/connect/headers ${url}`;
  let timer: NodeJS.Timeout;
  let stalled: Error | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new Error(`${step}: network stalled`);
      controller.abort(stalled);
    }, options.idleMs ?? 30_000);
  };
  report(step);
  arm();
  const heartbeat = setInterval(() => report(step), 5000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${step}: HTTP ${response.status}`);
    if (!response.body) throw new Error(`${step}: missing response body`);
    step = `network body ${url} (0 bytes)`;
    arm();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const value = new Uint8Array(chunk);
      chunks.push(value);
      bytes += value.byteLength;
      step = `network body ${url} (${bytes} bytes)`;
      report(step);
      arm();
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw stalled ?? new Error(`${step}: ${String(error)}`);
  } finally {
    clearTimeout(timer!);
    clearInterval(heartbeat);
  }
}
