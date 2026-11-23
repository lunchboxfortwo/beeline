import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { runOwned } from './wait.js';

/** VMGenID reseeding is a kernel event, delivered before the restored guest runs. */
export function watchFreeAgentResume(onResume: () => void, source?: Readable): () => void {
  let input = source;
  const reading = new AbortController();
  // --follow-new seeks past boot history, then blocks on kernel log records.
  if (!source)
    runOwned({
      step: 'dmesg --follow-new',
      file: 'dmesg',
      args: ['--follow-new', '--raw'],
      captureOutput: false,
      machineRead: true,
      signal: reading.signal,
      onSpawn: (child) => {
        input = child.stdout!;
        child.stderr?.pipe(process.stderr, { end: false });
      },
    }).catch((error: unknown) => {
      if (!reading.signal.aborted) console.error('[free-agent] resume event reader failed:', error);
    });
  const lines = createInterface({ input: input! });
  lines.on('line', (line) => {
    if (line.endsWith('random: crng reseeded due to virtual machine fork')) onResume();
  });
  return () => {
    lines.close();
    reading.abort();
  };
}
