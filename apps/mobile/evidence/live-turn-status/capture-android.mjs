import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const serial = process.argv[2];
if (!serial) throw Error('Pass the currently granted emulator serial');
const browser = await chromium.connectOverCDP('http://127.0.0.1:19495');
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:18495/'));
if (!page) throw Error('Open the local proof page on the granted emulator first');
for (const version of ['before', 'after']) for (const theme of ['light_brass', 'dark_brass']) {
  await page.goto(`http://127.0.0.1:18495/?version=${version}&theme=${theme}`);
  await page.getByTestId('thread-row').waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (version === 'after') {
    await page.evaluate(() => globalThis.finishStep());
    await page.getByText('3 steps', { exact: true }).waitFor();
    if (await page.getByText('Ruby is working', { exact: true }).count() !== 3) throw Error('Missing working surface');
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  writeFileSync(join(here, `${version}-${theme}-android.png`), execFileSync('adb', ['-H','127.0.0.1','-P','5037','-s',serial,'exec-out','screencap','-p']));
  await page.getByTestId('thread-row').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  writeFileSync(join(here, `${version}-${theme}-android-list.png`), execFileSync('adb', ['-H','127.0.0.1','-P','5037','-s',serial,'exec-out','screencap','-p']));
  console.log(version, theme, 'Android Chrome');
}
await browser.close();
