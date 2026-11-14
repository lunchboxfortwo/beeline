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
    // The bootstrap context supplies the first sample too. Its storage must
    // match later contexts, rather than retain the review landing's caches.
    await page.evaluate(
      (names) => {
        for (const key of Object.keys(localStorage))
          if (!names.includes(key)) localStorage.removeItem(key);
        sessionStorage.clear();
      },
      state.origins.flatMap((origin) => origin.localStorage.map(({ name }) => name)),
    );
    return state;
  } finally {
    await page.close();
  }
}
