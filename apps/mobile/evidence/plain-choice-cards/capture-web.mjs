// Plain choice cards web capture. Needs Metro serving the harness (see README) at METRO
// (default http://127.0.0.1:19251). For Bone and Obsidian it writes web-<theme>.png
// (open, answered, tap before) and web-<theme>-tapped.png (after one tap), and checks
// that each card shows only the question and its choices.
import path from 'node:path';
const playwright = await import(process.env.PCC_PLAYWRIGHT ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const metro = process.env.METRO ?? 'http://127.0.0.1:19251';
const out = path.resolve(process.argv[2] ?? 'evidence/plain-choice-cards');
const bundle = `${metro}/evidence/plain-choice-cards/harness.bundle?platform=web&dev=false&minify=false`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="${bundle}"></script></body></html>`;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const forbidden = ['Open one fix thread', 'approvals are settled', 'approve_all', 'not_now', 'Add a note', 'asked Approve', 'Skip'];
let failed = false;
const check = (label, text, want) => {
  const bad = forbidden.filter((word) => text.includes(word));
  const missing = want.filter((word) => !text.includes(word));
  if (bad.length || missing.length) failed = true;
  console.log(`${label}: ${bad.length || missing.length ? `WRONG shows [${bad.join(', ')}] lacks [${missing.join(', ')}]` : 'question and choices only'} | ${text.replace(/\n+/g, ' / ')}`);
};
try {
  for (const theme of ['bone', 'obsidian']) {
    const page = await browser.newPage({ viewport: { width: 411, height: 640 }, deviceScaleFactor: 2, timezoneId: 'UTC' });
    await page.route(`${metro}/plain-choice-cards.html*`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${metro}/plain-choice-cards.html?theme=${theme}`);
    await page.waitForSelector('[data-testid="tap-open"]', { timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    const text = (id) => page.evaluate((testId) => document.querySelector(`[data-testid="${testId}"]`).innerText, id);
    check(`${theme} open`, await text('open'), ["Approve fixes from today's card?", 'Approve all', 'Not now']);
    check(`${theme} answered`, await text('answered'), ["Approve fixes from today's card?", 'Approve all · picked A · @lunchboxfortwo']);
    await page.screenshot({ path: path.join(out, `web-${theme}.png`), fullPage: true });
    await page.locator('[data-testid="tap-open"]').getByText('Approve all', { exact: true }).click();
    await page.waitForSelector('[data-testid="tap-answered"]', { timeout: 10000 });
    check(`${theme} tapped`, await text('tap-answered'), ["Approve fixes from today's card?", 'Approve all · picked A · @lunchboxfortwo']);
    await page.screenshot({ path: path.join(out, `web-${theme}-tapped.png`), fullPage: true });
    await page.close();
  }
} finally { await browser.close(); }
if (failed) process.exit(1);
