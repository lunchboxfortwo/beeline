import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** VMGenID reseeding is a kernel event, delivered before the restored guest runs. */
export function watchFreeAgentResume(onResume: () => void, source?: Readable): () => void {
  // --follow-new seeks past boot history, then blocks on kernel log records.
  const child = source ? undefined : spawn('dmesg', ['--follow-new', '--raw'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child?.once('error', error => console.error('[free-agent] resume event reader failed:', error));
  child?.stderr?.pipe(process.stderr, { end: false });
  const lines = createInterface({ input: source ?? child!.stdout! });
  lines.on('line', line => {
    if (line.endsWith('random: crng reseeded due to virtual machine fork')) onResume();
  });
  return () => { lines.close(); child?.kill(); };
}
