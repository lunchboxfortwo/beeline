import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Every capture and the reviewer bootstrap use the same isolated network. */
export async function fixtureContext(
  browser,
  { origin, backend, blockedRequests, capture, storageState, socketRoute },
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: origin.origin,
    serviceWorkers: 'block',
    storageState,
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
      // A sample can close its page while an image request is still in flight.
      // That request belongs to no measurement; ending it must not stop the run.
      try {
        const response = await route.fetch();
        return await route.fulfill({
          response,
          headers: { ...response.headers(), 'access-control-allow-origin': origin.origin },
        });
      } catch (error) {
        if (error?.name?.startsWith('TargetClosedError') || /closed|disposed/i.test(error?.message ?? '')) return;
        throw error;
      }
    }
    blockedRequests.push({ capture, origin: url.origin });
    await route.abort();
  });
  await context.routeWebSocket(
    '**/*',
    socketRoute ??
      ((socket) => {
        const url = new URL(socket.url());
        if (url.hostname === backend.hostname && url.port === backend.port)
          socket.connectToServer();
        else {
          blockedRequests.push({ capture, origin: url.origin });
          socket.close();
        }
      }),
  );
  return context;
}

/** Redeem once per run; save only credentials for fresh tap and route contexts. */
export async function saveReviewerSession(browser, options) {
  const context = await fixtureContext(browser, { ...options, capture: 'sign-in' });
  try {
    const state = await fixtureSignIn(context, options.secret);
    const path = resolve(options.out, 'reviewer-session.json');
    await writeFile(path, JSON.stringify(state) + '\n', { mode: 0o600 });
    return path;
  } finally {
    await context.close();
  }
}

/** Reuse only the local fixture's credentials, never a previous surface snapshot. */
export async function fixtureSignIn(context, secret) {
  const page = await context.newPage();
  try {
    await page.goto(`/review/${secret}`);
    await page.waitForURL('**/beeline/channels**', { timeout: 15000 });
    const state = await context.storageState();
    for (const origin of state.origins)
      origin.localStorage = origin.localStorage.filter(({ name }) =>
        /^buzzy\.monolith\.(identity|access|refresh)\.v1$/.test(name),
      );
    return state;
  } finally {
    await page.close();
  }
}
