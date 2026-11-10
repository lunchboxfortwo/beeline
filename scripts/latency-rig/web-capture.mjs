#!/usr/bin/env node
/** Paired, local-only browser captures; missing data never becomes a fast sample. */
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixture, scenarios, resetWebFixture, verifyWebEffect } from './web-fixtures.mjs';
import { steps, exclusions } from './web-steps.mjs';
import { captureRoutes } from './web-route-capture.mjs';
import { measureLongPress } from './web-long-press.mjs';
import { armForwardTiming, readForwardTiming } from './web-forward-timing.mjs';
async function bounded(work, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function validateInventory(inventory, fixtures = scenarios, drivers = steps) {
  if (new Set(inventory).size !== inventory.length)
    throw new Error('Duplicate interaction in inventory');
  for (const name of inventory) {
    if (!Object.hasOwn(fixtures, name)) throw new Error(`Missing fixture: ${name}`);
    if (!Object.hasOwn(drivers, name) || typeof drivers[name] !== 'function')
      throw new Error(`Missing driver step: ${name}`);
  }
}
export function summarize(inventory, captures, { samplesPerCapture = 20, budgetMs = 150 } = {}) {
  const rows = [],
    unmeasured = [];
  for (const name of inventory) {
    const paired = captures.filter((c) => c.name === name);
    if (
      paired.length !== 2 ||
      new Set(paired.map((c) => c.capture)).size !== 2 ||
      !paired.every((c) => [1, 2].includes(c.capture)) ||
      paired.some(
        (c) =>
          c.samples.length !== samplesPerCapture ||
          c.reason ||
          c.samples.some((n) => !Number.isFinite(n) || n <= 0),
      )
    ) {
      unmeasured.push({
        name,
        availability: ['switch-workspace', 'create-room'].includes(name)
          ? 'out-of-scope'
          : exclusions[name]
            ? ['approve-merge', 'connect-app'].includes(name) ? 'external' : 'unavailable'
            : 'incomplete',
        reason:
          paired
            .filter((c) => c.reason)
            .map((c) => `Capture ${c.capture}: ${c.reason}`)
            .join('; ') ||
          `Requires two complete captures of ${samplesPerCapture} positive finite samples`,
        captures: paired.map((c) => ({ capture: c.capture, samples: c.samples.length })),
      });
      continue;
    }
    const percentile = (values, p) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const values = paired.flatMap((c) => c.samples);
    const longPress = paired.flatMap((c) => c.longPressTimings ?? []);
    const forward = paired.flatMap((c) => c.forwardTimings ?? []);
    rows.push({
      name,
      samples: samplesPerCapture * 2,
      ...(name === 'send-attachment'
        ? {
            timingContract:
              'web file selection through upload, Send, rendered attachment and two frames; excludes human time in OS picker chrome',
          }
        : {}),
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      ...(forward.length === 40
        ? {
            timingContract:
              'action start to accepted visible feedback plus two frames, or picker removal plus two frames on clients without feedback',
            driverObserved: {
              p50Ms: percentile(
                forward.map((t) => t.driverObservedMs),
                0.5,
              ),
              p95Ms: percentile(
                forward.map((t) => t.driverObservedMs),
                0.95,
              ),
            },
            profile: Object.fromEntries(
              Object.keys(forward[0])
                .filter((k) => k !== 'driverObservedMs')
                .map((key) => [
                  key,
                  forward.some((t) => !Number.isFinite(t[key]))
                    ? {
                        p50Ms: null,
                        p95Ms: null,
                        observedSamples: forward.filter((t) => Number.isFinite(t[key])).length,
                      }
                    : {
                        p50Ms: percentile(
                          forward.map((t) => t[key]),
                          0.5,
                        ),
                        p95Ms: percentile(
                          forward.map((t) => t[key]),
                          0.95,
                        ),
                      },
                ]),
            ),
          }
        : {}),
      ...(longPress.length === 40
        ? {
            timingContract: 'long-press recognition to observed rendered result',
            gestureInclusive: {
              p50Ms: percentile(
                longPress.map((t) => t.gestureInclusiveMs),
                0.5,
              ),
              p95Ms: percentile(
                longPress.map((t) => t.gestureInclusiveMs),
                0.95,
              ),
            },
          }
        : {}),
      captures: paired.map((c) => ({
        capture: c.capture,
        samples: samplesPerCapture,
        p50Ms: percentile(c.samples, 0.5),
        p95Ms: percentile(c.samples, 0.95),
      })),
    });
  }
  // A percentage of interactions meeting the existing 150ms tap p50 budget.
  // Incomplete inventories have no score, not a misleading partial average.
  return {
    fullInventoryScore:
      unmeasured.length || !inventory.length
        ? null
        : (100 * rows.filter((r) => r.p50Ms < budgetMs).length) / inventory.length,
    scoreDefinition: `Percentage of the complete inventory with paired pooled p50 below ${budgetMs} ms; null if any item is unmeasured`,
    coverage: { measured: rows.length, total: inventory.length },
    rows,
    unmeasured,
  };
}
function local(value, label) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`${label} must use loopback`);
  return url;
}
async function main() {
  const out = resolve(process.argv[2] ?? '.beeline-proof/web-latency');
  await mkdir(out, { recursive: true });
  const origin = local(
    process.env.LATENCY_RIG_WEB_ORIGIN ?? 'http://127.0.0.1:18089',
    'Web origin',
  );
  const backend = local(process.env.LATENCY_RIG_WEB_BACKEND ?? 'http://127.0.0.1:18090', 'Backend');
  const databaseUrl = local(process.env.LATENCY_RIG_DATABASE_URL ?? '', 'Database');
  if (!databaseUrl.pathname.includes('latency_rig'))
    throw new Error('Database name must contain latency_rig');
  if (
    databaseUrl.searchParams.has('host') &&
    databaseUrl.searchParams.get('host') !== '/var/run/postgresql'
  )
    throw new Error('Only the local PostgreSQL socket is allowed');
  const secret = process.env.LATENCY_RIG_REVIEW_SECRET;
  if (!secret) throw new Error('LATENCY_RIG_REVIEW_SECRET required');
  const inventory = JSON.parse(
    await readFile(new URL('./interactions.json', import.meta.url), 'utf8'),
  );
  validateInventory(inventory);
  const selected = process.env.LATENCY_RIG_WEB_INTERACTION;
  if (selected && !inventory.includes(selected))
    throw new Error(`Unknown interaction: ${selected}`);
  const captureInventory =
    process.env.LATENCY_RIG_WEB_ROUTES_ONLY === '1' ? [] : selected ? [selected] : inventory;
  const routes = JSON.parse(await readFile(new URL('./routes.json', import.meta.url), 'utf8'));
  for (const name of inventory)
    if (!routes.some((route) => route.path === fixture(name).route))
      throw new Error(`Fixture route missing from routes.json: ${name}`);
  const { chromium } = await import('playwright');
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: databaseUrl.href });
  await db.connect();
  const captures = [],
    blockedRequests = [];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'web-fixtures.mjs',
        'web-steps.mjs',
        'web-capture.mjs',
        'web-route-capture.mjs',
        'web-route-fixtures.mjs',
        'local-object-store.mjs',
        'check-routes.mjs',
        'web-forward-timing.mjs',
        'web-long-press.mjs',
        'interactions.json',
        'routes.json',
      ].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(new URL(name, import.meta.url)))
          .digest('hex'),
      ]),
    ),
  );
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    for (let capture = 1; capture <= 2; capture++) {
      for (const name of inventory)
        if (!exclusions[name]) await resetWebFixture(db, fixture(name), false);
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        baseURL: origin.origin,
        serviceWorkers: 'block',
      });
      // Only this known local API gets CORS headers. No production host, asset,
      // analytics endpoint or OAuth page may escape the isolated fixture.
      await context.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin === origin.origin) return route.continue();
        if (url.origin === backend.origin) {
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
        }
        blockedRequests.push({ capture, origin: url.origin });
        await route.abort();
      });
      await context.routeWebSocket('**/*', (socket) => {
        const url = new URL(socket.url());
        if (url.hostname === backend.hostname && url.port === backend.port)
          socket.connectToServer();
        else {
          blockedRequests.push({ capture, origin: url.origin });
          socket.close();
        }
      });
      let page = await context.newPage();
      page.setDefaultTimeout(4000);
      page.setDefaultNavigationTimeout(6000);
      await page.goto(`/review/${secret}`);
      await page.waitForURL('**/beeline/channels**', { timeout: 15000 });
      for (const name of captureInventory) {
        const record = { name, capture, samples: [] };
        captures.push(record);
        const f = fixture(name);
        for (let sample = 0; sample < 20; sample++) {
          if (exclusions[name]) {
            record.reason = exclusions[name];
            break;
          }
          try {
            await page.goto('/__latency_blank.html');
            await bounded(
              () =>
                page.evaluate(async () => {
                  for (const key of Object.keys(localStorage)) {
                    if (key.startsWith('beeline.surface.') || key.startsWith('beeline.outbox.'))
                      localStorage.removeItem(key);
                  }
                  sessionStorage.clear();
                  for (const database of await indexedDB.databases()) {
                    await new Promise((resolve, reject) => {
                      const request = indexedDB.deleteDatabase(database.name);
                      request.onsuccess = resolve;
                      request.onerror = () => reject(new Error('Fixture cache deletion failed'));
                      request.onblocked = () => reject(new Error('Fixture cache is still open'));
                    });
                  }
                }),
              5000,
              'Fixture cache reset',
            );
            await resetWebFixture(db, f);
            const prepared = await bounded(
              () => steps[name](page, f, `rig-${name}-${capture}-${sample}`),
              12000,
              'Fixture setup',
            );
            if (prepared.unmeasured) {
              record.reason = prepared.unmeasured;
              break;
            }
            if (name === 'forward-message')
              await page.evaluate(armForwardTiming, { messageText: f.text });
            await bounded(
              () =>
                page.evaluate(() => {
                  window.__latencyStart = performance.now();
                }),
              2000,
              'Action start',
            );
            let duration;
            if (prepared.longPressThresholdMs !== undefined) {
              const timing = await bounded(
                () => measureLongPress(page, prepared),
                10000,
                'Long press and visible result',
              );
              (record.longPressTimings ??= []).push(timing);
              duration = timing.postRecognitionMs;
            } else {
              await bounded(
                async () => {
                  await prepared.act();
                  await prepared.done();
                },
                10000,
                'Action and visible result',
              );
              duration = await bounded(
                () =>
                  page.evaluate(
                    () =>
                      new Promise((resolve) =>
                        requestAnimationFrame(() =>
                          requestAnimationFrame(() =>
                            resolve(performance.now() - window.__latencyStart),
                          ),
                        ),
                      ),
                  ),
                2000,
                'Result frame',
              );
            }
            if (name === 'forward-message') {
              const timing = await page.evaluate(readForwardTiming);
              (record.forwardTimings ??= []).push({
                ...timing,
                driverObservedMs: duration,
                driverObservationLagMs: duration - timing.durationMs,
              });
              duration = timing.durationMs;
            }
            await bounded(
              () => verifyWebEffect(db, f, `rig-${name}-${capture}-${sample}`),
              3000,
              'Committed effect',
            );
            record.samples.push(duration);
          } catch (error) {
            record.reason = `Sample ${sample + 1}: ${stripVTControlCharacters(error.message)}`;
            await page
              .screenshot({ path: resolve(out, `${name}-${capture}-failure.png`), timeout: 1500 })
              .catch(() => {});
            await writeFile(
              resolve(out, `${name}-${capture}-failure.txt`),
              await page
                .locator('body')
                .innerText({ timeout: 1500 })
                .catch(() => ''),
            );
            await page.close();
            page = await context.newPage();
            page.setDefaultTimeout(4000);
            page.setDefaultNavigationTimeout(6000);
            break;
          }
        }
        console.log(
          `${name} capture=${capture} samples=${record.samples.length}${record.reason ? ` unmeasured: ${record.reason.split('\n')[0]}` : ''}`,
        );
        await writeFile(resolve(out, 'captures.json'), JSON.stringify(captures, null, 2) + '\n');
      }
      await context.close();
    }
    const selectedRoute = process.env.LATENCY_RIG_WEB_ROUTE;
    if (selectedRoute && !routes.some((route) => route.path === selectedRoute))
      throw new Error(`Unknown web route: ${selectedRoute}`);
    const routeInventory =
      process.env.LATENCY_RIG_WEB_ROUTES === '1' || process.env.LATENCY_RIG_WEB_ROUTES_ONLY === '1'
        ? await captureRoutes({
            browser,
            routes: selectedRoute ? routes.filter((route) => route.path === selectedRoute) : routes,
            origin,
            backend,
            secret,
            out,
            blockedRequests,
          })
        : undefined;
    const summary = {
      routeInventory,
      schemaVersion: 1,
      longPressContract:
        'pointerdown + threshold from source to existing result plus two frames; observed during hold; gesture-inclusive timings retained separately',
      platform: 'headless-chromium-web',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      browser: browser.version(),
      sourceHashes,
      method:
        'User action to observed destination/result DOM plus two animation frames, including driver overhead; upper bound, not physical scanout. Setup, reset and sign-in excluded. Forward completion uses accepted visible feedback plus two frames when present, otherwise in-page removal plus two frames; driver-observed durations are retained separately. Local server only; no injected network delay.',
      ...summarize(inventory, captures),
      blockedRequests,
    };
    await writeFile(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary.coverage));
  } finally {
    await browser?.close();
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
