/** Chromium page counters, sampled outside the visible-response clock. */
import { freemem, loadavg, totalmem } from 'node:os';
const sessions = new WeakMap();

export async function readWebResources(context, page) {
  let session = sessions.get(page);
  if (!session) {
    session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    // The owning context closes this session. Keep counters enabled across the
    // action so duration deltas include the work between the two observations.
    sessions.set(page, session);
  }
  const { metrics } = await session.send('Performance.getMetrics');
  const names = new Set([
    'JSHeapUsedSize',
    'JSHeapTotalSize',
    'Nodes',
    'Documents',
    'JSEventListeners',
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
  ]);
  return {
    page: Object.fromEntries(
      metrics.filter(({ name }) => names.has(name)).map(({ name, value }) => [name, value]),
    ),
    host: { loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() },
  };
}
