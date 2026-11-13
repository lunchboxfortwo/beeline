import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const here = import.meta.dirname;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/google-chrome' });
await mkdir(path.join(here, 'screenshots'), { recursive: true });
const results = [];
try {
  for (const theme of ['bone', 'obsidian']) for (const [device, width] of [['phone', 390], ['web', 960]]) {
    for (const before of [true, false]) {
      const page = await browser.newPage({ viewport: { width, height: 640 } });
      page.on('pageerror', error => { throw error; });
      await page.goto(`file://${here}/index.html?theme=${theme}${before ? '&before' : ''}`);
      page.setDefaultTimeout(10000);
      const report = page.getByTestId('person-report');
      await report.waitFor();
      const personVisible = await report.getByText(/needs-decision: Choose the endpoint/).isVisible();
      const legacyVisible = await page.getByTestId('legacy-report').getByText(/blocked: This older report/).isVisible();
      const agentVisible = await page.getByTestId('agent-report').getByText(/done: The agent-only/).isVisible();
      if (personVisible === before || legacyVisible === before || agentVisible) throw Error('UAR-1 visibility regression');
      await page.screenshot({ path: path.join(here, 'screenshots', `${device}-${theme}-${before ? 'before' : 'after'}.png`) });
      results.push({ device, theme, before, personVisible, legacyVisible, agentVisible });
      await page.close();
    }
  }
  await writeFile(path.join(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log('UAR-1 PASS: person and unknown reports readable after; agent reports remain collapsed; Bone/Obsidian, phone/web widths.');
} finally { await browser.close(); }
