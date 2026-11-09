// Isolated HTTP/live process proof; no database, credentials or production services.
const extension = process.env.BEELINE_SHUTDOWN_BUILT ? 'js' : 'ts';
const directory = process.env.BEELINE_SHUTDOWN_BUILT ? 'dist' : 'src';
const { createBeelineServer } = await import(`../${directory}/server.${extension}`);
const { LiveHub } = await import(`../${directory}/live.${extension}`);
const { installShutdown } = await import(`../${directory}/shutdown.${extension}`);
const server = createBeelineServer({
  database: { query: async () => ({ rows: [], rowCount: 0 }), transaction: async () => {} },
  auth: { authenticateDaemon: async () => 'shutdown-agent' },
  phone: {}, daemon: {}, live: new LiveHub(), mediaMaximumBytes: 1,
  authHandler: (_request, response) => {
    process.send?.({ type: 'request-started' });
    if (!process.env.BEELINE_SHUTDOWN_STUCK_REQUEST) setTimeout(() => response.end('completed'), 300);
  },
});
installShutdown(server, async () => {
  process.send?.({ type: 'cleanup' });
  if (process.env.BEELINE_SHUTDOWN_STUCK_CLEANUP) await new Promise(() => {});
});
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
