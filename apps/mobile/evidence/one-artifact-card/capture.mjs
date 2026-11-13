import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('.', import.meta.url));
const before = process.argv.includes('--before');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 430, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => { throw error; });
    await page.goto('http://127.0.0.1:8101');
    await page.getByTestId('proof-phase').waitFor();
    if (theme === 'dark') await page.getByText('Switch theme', { exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByTestId('proof-phase').filter({ hasText: 'sending' }).waitFor();
    if (before) {
      if (await page.getByTestId('artifact-image-shot.png').count()) throw new Error('Expected original upload interval without a card');
      await page.screenshot({ path: `${out}before-${theme}-sending.png`, fullPage: true });
      await context.close();
      continue;
    }
    const bounds = [];
    for (const state of ['sending', 'settled', 'refreshed']) {
      if (state === 'settled') {
        await page.getByText('Resolve upload', { exact: true }).click();
        await page.getByTestId('proof-phase').filter({ hasText: 'settled' }).waitFor();
      }
      if (state === 'refreshed') {
        await page.getByText('Refresh history without decoration', { exact: true }).click();
        await page.getByTestId('proof-phase').filter({ hasText: 'refreshed' }).waitFor();
      }
      const card = page.getByTestId('artifact-image-shot.png');
      await card.waitFor();
      if (state === 'sending') await page.getByTestId('artifact-preview-loading').waitFor();
      else {
        await card.locator('img').waitFor({ state: 'attached' });
        await page.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0));
      }
      const box = await card.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > 1000) throw new Error('Card is clipped');
      bounds.push({ state, ...box });
      await page.screenshot({ path: `${out}${theme}-${state}.png`, fullPage: true });
    }
    if (bounds.some(box => box.width !== bounds[0].width || box.height !== bounds[0].height)) throw new Error('Card dimensions changed');
    results.push({ theme, bounds });
    await context.close();
  }
  if (!before) writeFileSync(`${out}measurements.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await browser.close(); }
