import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const here = import.meta.dirname;
const before = Boolean(process.env.BEFORE);
const label = before ? 'before' : 'after';
const server = createServer(async (req, res) => {
  const filename = req.url.startsWith('/bundle.js') ? 'bundle.js' : 'index.html';
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(await readFile(`${here}/${filename}`));
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [393, 1280]) for (const theme of ['bone', 'obsidian']) {
    const page = await browser.newPage({ viewport: { width, height: 500 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    const loading = page.getByTestId('artifact-image-loading');
    await loading.waitFor();
    await page.evaluate(() => document.fonts.ready);
    const row = page.getByTestId('chat-attachment-29559.jpg');
    const geometry = async () => row.evaluate(el => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
      return { row: rect(el), image: rect(el.children[0]), copy: rect(el.children[1]), name: el.children[1].children[0].textContent, metadata: el.children[1].children[1].textContent };
    });
    const pending = await geometry();
    await page.screenshot({ path: `${here}/${label}-${width}-${theme}-loading.png` });
    await page.evaluate(() => window.finish());
    await page.getByTestId('chat-attachment-thumbnail-29559.jpg').waitFor();
    const loaded = await geometry();
    await page.screenshot({ path: `${here}/${label}-${width}-${theme}-loaded.png` });
    assert.equal(loaded.image.width, 46);
    assert.equal(loaded.image.height, 46);
    assert.equal(pending.name, '29559.jpg');
    assert.equal(pending.metadata, 'IMAGE/JPEG · 592 KB');
    if (before) assert.ok(pending.image.width > 100);
    else {
      assert.deepEqual(pending, loaded);
      assert.ok(pending.copy.width > 250);
    }
    assert.deepEqual(errors, []);
    await page.reload(); await loading.waitFor();
    await page.evaluate(() => window.fail());
    await page.getByTestId('artifact-image-failed').waitFor();
    assert.equal(await page.getByText('Image unavailable', { exact: true }).count(), 1);
    assert.equal(await page.getByText('deferred.jpg', { exact: true }).count(), 1);
    results.push({ width, theme, pending, loaded, failure: true, deferred: true });
    await page.close();
  }
  await writeFile(`${here}/results-${label}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ label, results }));
} finally { await browser.close(); server.close(); }
