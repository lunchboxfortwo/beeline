import { mkdir, watch } from 'node:fs/promises';
import { dirname } from 'node:path';
import { helperStatusPath } from '../../../apps/body/src/helper-status.ts';
import { askMachine, helperAbsent } from '../../../apps/body/src/machine-control.ts';

/**
 * Proof harness only. The helper answers one status request at a time, so a
 * proof re-asks on each write of the helper's status file until `accept`
 * holds; the proof's own deadline fails the proof, never the helper.
 */
export async function observeHelper(
  stateRoot,
  accept = () => true,
  timeoutMs = 90_000,
  onStatus = () => {},
) {
  const directory = dirname(helperStatusPath(stateRoot));
  await mkdir(directory, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`helper observation timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const changes = watch(directory, { signal: controller.signal })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const status = await askMachine(stateRoot, { operation: 'status' }, false).catch((error) => {
        // A helper the proof is killing resets the connection; re-read on its next status write.
        if (helperAbsent(error) || error?.code === 'ECONNRESET') return undefined;
        throw error;
      });
      if (status) {
        onStatus(status);
        if (accept(status)) return status;
      }
      if ((await changes.next()).done) throw new Error('helper status watcher ended');
    }
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
