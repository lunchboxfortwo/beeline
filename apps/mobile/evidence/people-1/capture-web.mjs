// PEOPLE-1 web capture. Needs Metro serving the harness (see README) at METRO
// (default http://127.0.0.1:19249). Writes web-<theme>.png and prints each
// label's rendered height and whether it is clipped.
import path from 'node:path';
const playwright = await import(process.env.PEOPLE1_PLAYWRIGHT ?? 'playwright-core');
const chromium = playwright.chromium ?? playwright.default.chromium;
const metro = process.env.METRO ?? 'http://127.0.0.1:19249';
const out = path.resolve(process.argv[2] ?? 'evidence/people-1');
const bundle = `${metro}/evidence/people-1/harness.bundle?platform=web&dev=false&minify=false`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="${bundle}"></script></body></html>`;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = false;
try {
  for (const theme of ['bone', 'obsidian']) {
    const page = await browser.newPage({ viewport: { width: 411, height: 914 }, deviceScaleFactor: 2 });
    await page.route(`${metro}/people-1.html*`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${metro}/people-1.html?theme=${theme}`);
    await page.waitForSelector('[data-testid="bar-pr-1.8"]', { timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="bar-"]')].map((bar) => ({
      id: bar.getAttribute('data-testid'),
      labels: ['Chats', 'Tags', 'People', 'Settings'].map((label) => {
        const tab = bar.querySelector(`[aria-label="${label}"]`);
        const text = [...tab.querySelectorAll('*')].find((node) => node.childElementCount === 0 && node.textContent === label);
        return { label, clipped: text.scrollWidth > text.clientWidth + 1, lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)) };
      }),
    })));
    for (const row of rows) {
      const bad = row.labels.filter((l) => l.clipped || l.lines > 1).map((l) => `${l.label}(${l.lines} lines${l.clipped ? ', clipped' : ''})`);
      if (row.id.startsWith('bar-pr') && bad.length) failed = true;
      console.log(`${theme} ${row.id}: ${bad.length ? `WRONG ${bad.join(' ')}` : 'full labels on one line'}`);
    }
    await page.screenshot({ path: path.join(out, `web-${theme}.png`), fullPage: true });
    await page.close();
  }
} finally { await browser.close(); }
if (failed) process.exit(1);
