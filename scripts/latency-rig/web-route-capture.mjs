/** Document loads through explicit content plus two frames; one fresh context per document sample. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { routeFixture, waitForRouteContent } from './web-route-fixtures.mjs';
import { summarize } from './web-capture.mjs';
import { readWebResources } from './web-resources.mjs';
import { armTapTiming } from './web-tap-timing.mjs';
import { fixtureSignIn } from './web-signin.mjs';

export async function captureRoutes({
  browser,
  routes,
  origin,
  backend,
  secret,
  out,
  blockedRequests,
  storageState,
}) {
  const captures = [];

  const count = Number(
    process.env.LATENCY_RIG_ROUTE_SMOKE_SAMPLES ??
      process.env.LATENCY_RIG_ROUTE_SAMPLES_PER_CAPTURE ??
      3,
  );
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new Error('Invalid route sample count');
  for (
    let capture = 1;
    capture <= (process.env.LATENCY_RIG_ROUTE_SMOKE_SAMPLES ? 1 : 2);
    capture++
  ) {
    for (const { path } of routes) {
      const config = routeFixture(path, secret);
      for (const variant of ['cold', 'warm']) {
        const record = {
          name: `${path} (${variant})`,
          path,
          variant,
          state: config.state,
          capture,
          cache: {
            app: variant === 'cold' ? 'cleared' : 'target-route-primed',
            http: 'disabled-by-request-routing-and-no-store-server',
            javascript: 'fresh-document-in-reused-browser',
          },
          samples: [],
          timings: [],
          resources: [],
        };
        captures.push(record);
        for (let sample = 0; sample < count; sample++) {
          const context = await browser.newContext({
            baseURL: origin.origin,
            viewport: { width: 390, height: 844 },
            serviceWorkers: 'block',
            storageState,
          });
          await context.route('**/*', async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (url.origin === origin.origin) return route.continue();
            if (url.origin !== backend.origin) {
              blockedRequests.push({ capture, lane: 'routes', origin: url.origin });
              return route.abort();
            }
            if (request.method() === 'OPTIONS')
              return route.fulfill({
                status: 204,
                headers: {
                  'access-control-allow-origin': origin.origin,
                  'access-control-allow-headers': '*',
                  'access-control-allow-methods': '*',
                },
              });
            const response = await route.fetch();
            return route.fulfill({
              response,
              headers: { ...response.headers(), 'access-control-allow-origin': origin.origin },
            });
          });
          await context.routeWebSocket('**/*', (socket) => {
            const url = new URL(socket.url());
            if (url.hostname === backend.hostname && url.port === backend.port) {
              const server = socket.connectToServer();
              socket.onMessage((message) => {
                let frame;
                try {
                  frame = JSON.parse(message.toString());
                } catch {
                  return server.send(message);
                }
                // No wallet provider is present locally. Fixture ONLY its read DTO;
                // never intercept a write, grant, balance refresh or spending action.
                if (frame.op === 'readWallet')
                  return socket.send(
                    JSON.stringify({
                      t: 'res',
                      id: frame.id,
                      ok: true,
                      result: {
                        address: '0x0000000000000000000000000000000000000000',
                        solanaAddress: null,
                        totalUsd: '$0.00',
                        coins: [],
                        chains: [
                          {
                            id: 'base',
                            name: 'Base',
                            feeUsd: null,
                            sponsored: true,
                            hasBalance: false,
                          },
                        ],
                        sponsorship: null,
                        delegation: { active: false, expiresAt: null },
                      },
                    }),
                  );
                server.send(message);
              });
            } else socket.close();
          });
          const page = await context.newPage();
          page.setDefaultTimeout(5000);
          page.setDefaultNavigationTimeout(15000);
          try {
            if (!storageState) {
              storageState = await fixtureSignIn(context, secret);
            }
            try {
              // A warm page that never shows its fixture used to throw here and
              // stop the whole sweep. Record that sample and keep going.
              if (variant === 'warm') {
                await page.goto(config.url);
                await waitForRouteContent(page, config);
              }
              // Routing disables HTTP caching in both variants. Only application
              // storage is primed by the warm target load.
              await page.goto('/__latency_blank.html');
              if (variant === 'cold') {
                await page.evaluate(async () => {
                  for (const key of Object.keys(localStorage))
                    if (key.startsWith('beeline.surface.') || key.startsWith('beeline.outbox.'))
                      localStorage.removeItem(key);
                  sessionStorage.clear();
                  for (const { name } of await indexedDB.databases())
                    await new Promise((resolve, reject) => {
                      const r = indexedDB.deleteDatabase(name);
                      r.onsuccess = resolve;
                      r.onerror = () => reject(new Error('Could not delete surface cache'));
                      r.onblocked = () => reject(new Error('Surface cache remains open'));
                    });
                });
                const session = await context.newCDPSession(page);
                await session.send('Network.clearBrowserCache');
                await session.detach();
              }
              const before = await readWebResources(context, page);
              await page.addInitScript(armTapTiming, {
                ...config,
                scope: 'body',
                navigation: true,
                hidden: config.absent,
                path: undefined,
              });
              const started = performance.now();
              await page.goto(config.url, { waitUntil: 'commit' });
              await waitForRouteContent(page, config);
              const timing = await page.evaluate(async () => {
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                return {
                  ...window.__latencyTapTiming,
                  navigation: performance
                    .getEntriesByType('navigation')
                    .map((entry) => entry.toJSON()),
                  resources: performance
                    .getEntriesByType('resource')
                    .map((entry) => entry.toJSON()),
                };
              });
              if (!Number.isFinite(timing.durationMs) || timing.durationMs <= 0)
                throw new Error('Route content frame was not observed');
              record.samples.push(timing.durationMs);
              record.timings.push({ ...timing, driverObservedMs: performance.now() - started });
              record.resources.push({ before, after: await readWebResources(context, page) });
              if (sample === 0 && capture === 1)
                await page.screenshot({
                  path: resolve(
                    out,
                    `route-${routes.findIndex((r) => r.path === path)}-${variant}.png`,
                  ),
                });
            } catch (error) {
              record.reason = `Sample ${sample + 1}: ${error.message.split('\n')[0]}`;
              await writeFile(
                resolve(
                  out,
                  `route-${routes.findIndex((r) => r.path === path)}-${variant}-failure.txt`,
                ),
                await page
                  .locator('body')
                  .innerText()
                  .catch(() => ''),
              );
              break;
            }
          } finally {
            await context.close();
          }
        }
        console.log(
          `${record.name} capture=${capture} samples=${record.samples.length}${record.reason ? ` ${record.reason}` : ''}`,
        );
        await writeFile(
          resolve(out, 'route-captures.json'),
          JSON.stringify(captures, null, 2) + '\n',
        );
      }
    }
  }
  const inventory = routes.flatMap(({ path }) =>
    ['cold', 'warm'].map((variant) => `${path} (${variant})`),
  );
  const summary = {
    samplesPerCapture: count,
    method:
      'Fresh context per sample; browser navigation time origin to explicit visible content plus two frames; driver totals retained separately. Cold clears application storage; warm primes the target route. HTTP caching is disabled in both variants by request routing and the no-store fixture server. Browser process is reused; compiled-code cache state is uncontrolled. Redirect and unavailable states retain their labels.',
    ...summarize(inventory, captures, { samplesPerCapture: count, budgetMs: 450 }),
    states: Object.fromEntries(routes.map(({ path }) => [path, routeFixture(path, secret).state])),
  };
  await writeFile(resolve(out, 'route-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
