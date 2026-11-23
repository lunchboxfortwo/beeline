import { onEnd, runOwned } from './wait.js';

/**
 * A worker started by runOwned with `ownerLink` reads EOF on stdin when its
 * owner dies, including by SIGKILL, which no exit hook can observe. It then
 * kills its own process group, so a killed command leaves no worker holding
 * its locks. This is an explicit end-of-file event, never a timer.
 */
export function exitWithOwner(): void {
  if (process.env.BEELINE_OWNER_LINK !== '1') return;
  process.stdin.resume();
  process.stdin.on('end', () => {
    // Registered after any runOwned exit hook, so the worker's own owned groups
    // are killed first, then its group, itself last.
    onEnd(process, ['exit'], () => {
      try {
        process.kill(0, 'SIGKILL');
      } catch {
        /* already gone */
      }
    });
    process.exit(1);
  });
  // The link must not keep a finished worker alive.
  process.stdin.unref?.();
}

/** One of our own workers as an owned child that dies with this owner; its stdout is the answer. */
export async function runWorker(
  step: string,
  entry: string,
  command: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const worker = await runOwned({
    step,
    file: process.execPath,
    args: [entry, command],
    env,
    ownerLink: true,
    ...(signal ? { signal } : {}),
  });
  if (worker.code !== 0)
    throw new Error(
      `${step}: worker exited ${worker.code ?? worker.signal}${worker.stderr ? `: ${worker.stderr.trim().split('\n').at(-1)}` : ''}`,
    );
  return worker.stdout;
}

export async function withCallerSignal<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal) return work(signal);
  const controller = new AbortController();
  const abort = (name: 'SIGINT' | 'SIGTERM') => {
    controller.abort(new Error('Operation cancelled'));
    process.kill(process.pid, name);
  };
  const interrupt = () => abort('SIGINT'),
    terminate = () => abort('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    return await work(controller.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}
