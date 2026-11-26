import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateArtifact } from '../../apps/body/dist/artifact-validation.js';
import {
  PROOF_MATRIX,
  PROOF_THEMES,
  PROOF_VIEWPORTS,
  captureSurfaceFrames,
  generateSurfaceProof,
  renderContactSheetHtml,
  renderContactSheetPng,
} from './ui-surface-proof.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function readPngDimensions(buffer) {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length >= 24, 'expected PNG buffer with IHDR');
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function makeFixtureSite(dir) {
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fixture Surface</title>
<style>
  :root { --bg: #fafaf9; --card: #f5f5f4; --ink: #1c1917; --stroke: #e7e5e4; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #171717; --card: #222222; --ink: #fafaf9; --stroke: #353535; }
  }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--ink); font-family: sans-serif; }
  .card { background: var(--card); border: 1px solid var(--stroke); border-radius: 10px; padding: 16px; }
</style>
</head>
<body>
  <div class="card" id="surface">
    <h1 id="heading">Surface</h1>
    <p id="meta"></p>
  </div>
  <script>
    const saved = JSON.parse(localStorage.getItem('beeline.settings.local-settings') || '{}');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.getElementById('heading').textContent = (saved.palette || 'unknown') + ' ' + scheme;
    document.getElementById('meta').textContent =
      window.innerWidth + 'x' + window.innerHeight + ' · appearance=' + (saved.appearance || 'none');
  </script>
</body>
</html>`,
    'utf8',
  );
}

test('captures all 6 viewport/theme cells and produces validateArtifact-compliant HTML and PNG', async () => {
  assert.equal(PROOF_VIEWPORTS.length, 3);
  assert.equal(PROOF_THEMES.length, 2);
  assert.equal(PROOF_MATRIX.length, 6);

  const fixtureDir = mkdtempSync(join(tmpdir(), 'beeline-ui-proof-fixture-'));
  const outputDir = mkdtempSync(join(tmpdir(), 'beeline-ui-proof-out-'));
  try {
    makeFixtureSite(fixtureDir);
    const outHtml = join(outputDir, 'proof.html');
    const outPng = join(outputDir, 'proof.png');
    const title = '6-frame surface proof · test';

    const result = await generateSurfaceProof({
      dir: fixtureDir,
      route: '/',
      out: outHtml,
      png: outPng,
      title,
      waitFor: '#surface',
    });

    assert.equal(result.frames.length, 6);
    assert.deepEqual(
      result.frames.map((frame) => frame.key),
      [
        'phone-dark',
        'narrow-web-dark',
        'desktop-dark',
        'phone-light',
        'narrow-web-light',
        'desktop-light',
      ],
    );

    const byKey = new Map(result.frames.map((frame) => [frame.key, frame]));
    assert.deepEqual(readPngDimensions(byKey.get('phone-dark').pngBuffer), { width: 780, height: 1688 });
    assert.deepEqual(readPngDimensions(byKey.get('narrow-web-dark').pngBuffer), { width: 780, height: 1688 });
    assert.deepEqual(readPngDimensions(byKey.get('desktop-dark').pngBuffer), { width: 1440, height: 900 });
    assert.deepEqual(readPngDimensions(byKey.get('phone-light').pngBuffer), { width: 780, height: 1688 });
    assert.deepEqual(readPngDimensions(byKey.get('narrow-web-light').pngBuffer), { width: 780, height: 1688 });
    assert.deepEqual(readPngDimensions(byKey.get('desktop-light').pngBuffer), { width: 1440, height: 900 });

    assert.equal(
      byKey.get('phone-dark').pngBuffer.equals(byKey.get('phone-light').pngBuffer),
      false,
      'Stone Dark and Stone Light captures must differ visually',
    );

    const htmlBytes = readFileSync(outHtml);
    assert.doesNotThrow(() => validateArtifact('text/html', htmlBytes, title));

    const htmlText = htmlBytes.toString('utf8');
    const inlineImages = htmlText.match(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/g) ?? [];
    assert.equal(inlineImages.length, 6, 'contact sheet must embed all 6 inline PNG data URLs');
    assert.match(htmlText, /6\/6/);
    for (const cell of PROOF_MATRIX) {
      assert.ok(htmlText.includes(`data-cell="${cell.key}"`), `missing cell ${cell.key}`);
    }

    const pngBytes = readFileSync(outPng);
    assert.doesNotThrow(() => validateArtifact('image/png', pngBytes, title));
    const stitched = readPngDimensions(pngBytes);
    assert.equal(stitched.width, 1400);
    assert.ok(stitched.height > 400, `expected stitched height > 400, got ${stitched.height}`);

    // Exercise direct helper exports cleanly.
    const directCapture = await captureSurfaceFrames({ dir: fixtureDir, waitFor: '#surface' });
    assert.equal(directCapture.frames.length, 6);
    const directPng = await renderContactSheetPng(result.html, { width: 1200 });
    assert.equal(readPngDimensions(directPng).width, 1200);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('renderContactSheetHtml rejects missing frames and escapes unsafe metadata cleanly', () => {
  assert.throws(() => renderContactSheetHtml({ frames: [] }), /Expected exactly 6 frames/);

  const minimalPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const frames = PROOF_MATRIX.map((cell) => ({
    key: cell.key,
    viewport: cell.viewport,
    theme: cell.theme,
    pngBuffer: minimalPng,
    byteLength: minimalPng.length,
  }));

  const html = renderContactSheetHtml({
    frames,
    title: 'Proof <script>alert(1)</script> onclick=x',
    subtitle: 'https://example.com & "quoted"',
    route: '/settings?a=1&b=2',
  });
  assert.doesNotThrow(() => validateArtifact('text/html', Buffer.from(html, 'utf8'), 'Escaped proof'));
  assert.doesNotMatch(html, /<script/i);
});

test('mobile-export-reachability checks both Android and Expo Web exports sequentially without leaks', () => {
  const script = readFileSync(join(repoRoot, 'packages/scripts/ci-workspace-tasks.sh'), 'utf8');
  const start = script.indexOf('mobile_export_reachability() {');
  assert.ok(start >= 0, 'mobile_export_reachability function missing');
  const body = script.slice(start, script.indexOf('\n}\n', start) + 3);

  const androidIndex = body.indexOf('--platform android');
  const webIndex = body.indexOf('--platform web');
  assert.ok(androidIndex > 0, 'Android export step missing');
  assert.ok(webIndex > androidIndex, 'Web export must run sequentially after Android export');
  assert.match(body, /npx expo export --max-workers 1 --platform web --output-dir "\$web_out" --clear/);
  assert.match(body, /_expo\/static\/js\/web/);
  assert.match(body, /transcript-speed\/\|__transcriptSpeed\|__transcriptBuild/);
  assert.match(body, /rm -rf "\$android_out"/);
  assert.match(body, /rm -rf "\$web_out"/);
});
