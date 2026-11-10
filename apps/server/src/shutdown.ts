import type { Server } from 'node:http';

export const REQUEST_DRAIN_MS = 5_000;
export const SHUTDOWN_DEADLINE_MS = 10_000;
export const LIVE_CLOSE_MS = 1_000;

/** Stop admission first; keep dependencies available until admitted requests finish. */
export function installShutdown(server: Server, cleanup: () => Promise<void>): void {
  let stopping = false;
  server.on('request', (_request, response) => {
    response.once('finish', () => {
      if (stopping) server.closeIdleConnections();
    });
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Keep this timer referenced: a hung cleanup must still exit before Fly kills us.
    const deadline = setTimeout(() => {
      console.error('[server] shutdown deadline reached');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    const drain = setTimeout(() => server.closeAllConnections(), REQUEST_DRAIN_MS);
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        clearTimeout(drain);
        await cleanup();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        console.error('[server] shutdown failed', error);
        process.exit(1);
      }
    })();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Bound peers that do not acknowledge the restart close frame. */
export async function finishLiveClose(closed: Promise<unknown>, terminate: () => void): Promise<void> {
  const deadline = setTimeout(terminate, LIVE_CLOSE_MS);
  try { await closed; } finally { clearTimeout(deadline); }
}
