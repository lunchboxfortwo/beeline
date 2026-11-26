#!/usr/bin/env node
/**
 * Generate a self-contained 6-frame cross-platform UI proof contact sheet
 * (Phone 390x844, Narrow Web 390x844, Desktop 1440x900 x Stone Dark & Light)
 * ready for `post_artifact`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const CHROMIUM_FALLBACK_PATHS = Object.freeze([
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);

export const PROOF_VIEWPORTS = Object.freeze([
  Object.freeze({
    id: 'phone',
    label: 'Phone',
    shortLabel: 'Phone',
    sizeLabel: '390×844',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  }),
  Object.freeze({
    id: 'narrow-web',
    label: 'Narrow Web',
    shortLabel: 'Web 390',
    sizeLabel: '390×844',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  }),
  Object.freeze({
    id: 'desktop',
    label: 'Desktop',
    shortLabel: 'Desk 1440',
    sizeLabel: '1440×900',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
]);

export const PROOF_THEMES = Object.freeze([
  Object.freeze({
    id: 'dark_stone',
    mode: 'dark',
    palette: 'stone',
    label: 'Stone Dark',
    shortLabel: 'Dark',
    colorScheme: 'dark',
    cellClass: 'dark-cell',
  }),
  Object.freeze({
    id: 'light_stone',
    mode: 'light',
    palette: 'stone',
    label: 'Stone Light',
    shortLabel: 'Light',
    colorScheme: 'light',
    cellClass: 'light-cell',
  }),
]);

export const PROOF_MATRIX = Object.freeze(
  PROOF_THEMES.flatMap((theme) =>
    PROOF_VIEWPORTS.map((viewport) =>
      Object.freeze({
        key: `${viewport.id}-${theme.mode}`,
        viewport,
        theme,
      }),
    ),
  ),
);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('=', '&#61;');
}

function chromiumLaunchEnv() {
  return existsSync('/tmp') ? { ...process.env, TMPDIR: '/tmp' } : undefined;
}

async function launchBrowser(explicitPath) {
  const env = chromiumLaunchEnv();
  const baseOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(env ? { env } : {}),
  };
  if (explicitPath) {
    return chromium.launch({ ...baseOptions, executablePath: explicitPath });
  }
  try {
    return await chromium.launch(baseOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Executable doesn't exist|Failed to launch/i.test(message)) throw error;
    for (const candidate of CHROMIUM_FALLBACK_PATHS) {
      if (existsSync(candidate)) {
        return chromium.launch({ ...baseOptions, executablePath: candidate });
      }
    }
    throw error;
  }
}

function resolveCellUrl(template, cell) {
  return template
    .replaceAll('{mode}', cell.theme.mode)
    .replaceAll('{theme}', cell.theme.id)
    .replaceAll('{viewport}', cell.viewport.id)
    .replaceAll('{width}', String(cell.viewport.width))
    .replaceAll('{height}', String(cell.viewport.height));
}

function startStaticExportServer(directory) {
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Export directory does not exist: ${root}`);
  }
  const indexHtml = join(root, 'index.html');
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }

    const stripped = pathname.replace(/^\/+/, '');
    const candidate = resolve(root, stripped);
    if (candidate !== root && !candidate.startsWith(rootPrefix)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const attempts = [candidate];
    if (stripped && !extname(stripped)) {
      attempts.push(`${candidate}.html`, join(candidate, 'index.html'));
    } else if (!stripped) {
      attempts.push(indexHtml);
    }
    if (existsSync(indexHtml)) attempts.push(indexHtml);

    for (const filePath of attempts) {
      if (!existsSync(filePath)) continue;
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;
      const mime = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectServer);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectServer(new Error('Could not bind static export server'));
        return;
      }
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

function assertValidPng(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_MAGIC.length) {
    throw new Error(`Expected non-empty PNG buffer for ${label}`);
  }
  if (!buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error(`Invalid PNG signature for ${label}`);
  }
}

export async function captureSurfaceFrames({
  url,
  dir,
  route = '/',
  waitFor,
  waitUntil = 'networkidle',
  timeoutMs = 30_000,
  chromiumPath,
  fullPage = false,
}) {
  if (!url && !dir) {
    throw new Error('Provide either url or dir to capture surface frames');
  }

  let server;
  let browser;
  try {
    let baseUrl = url;
    if (dir) {
      server = await startStaticExportServer(dir);
      const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
      baseUrl = `${server.origin}${normalizedRoute}`;
    }

    browser = await launchBrowser(chromiumPath);

    const frames = [];
    for (const cell of PROOF_MATRIX) {
      const cellUrl = resolveCellUrl(baseUrl, cell);
      const context = await browser.newContext({
        viewport: { width: cell.viewport.width, height: cell.viewport.height },
        deviceScaleFactor: cell.viewport.deviceScaleFactor,
        isMobile: cell.viewport.isMobile,
        hasTouch: cell.viewport.hasTouch,
        colorScheme: cell.theme.colorScheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.addInitScript(({ mode, palette }) => {
          try {
            window.localStorage.setItem('beeline.settings.appearance-system-v1', 'done');
            window.localStorage.setItem('beeline.settings.palette-stone-v1', 'done');
            window.localStorage.setItem(
              'beeline.settings.local-settings',
              JSON.stringify({
                appearance: mode,
                palette,
                roomOpenTraceOverlay: false,
                uiSize: 'medium',
                zenMode: false,
              }),
            );
          } catch {
            // Opaque or non-storage origins still honor prefers-color-scheme.
          }
          document.documentElement?.setAttribute('data-beeline-theme', `${mode}_${palette}`);
        }, { mode: cell.theme.mode, palette: cell.theme.palette });

        const page = await context.newPage();
        await page.goto(cellUrl, { waitUntil, timeout: timeoutMs });
        if (waitFor) {
          await page.waitForSelector(waitFor, { state: 'visible', timeout: timeoutMs });
        }
        await page.evaluate(async () => {
          if (document.fonts && typeof document.fonts.ready?.then === 'function') {
            await document.fonts.ready;
          }
          await new Promise((resolveFrame) =>
            requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
          );
        });

        const pngBuffer = await page.screenshot({ type: 'png', fullPage: Boolean(fullPage) });
        assertValidPng(pngBuffer, cell.key);
        frames.push({
          key: cell.key,
          viewport: cell.viewport,
          theme: cell.theme,
          url: cellUrl,
          pngBuffer,
          byteLength: pngBuffer.length,
        });
      } finally {
        await context.close();
      }
    }

    return {
      frames,
      baseUrl,
      route,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    await Promise.allSettled([
      browser ? browser.close() : Promise.resolve(),
      server ? server.close() : Promise.resolve(),
    ]);
  }
}

export function renderContactSheetHtml({
  frames,
  title = '6-frame surface proof',
  subtitle = 'Phone 390×844 · Narrow Web 390×844 · Desktop 1440×900 · Stone Dark & Light',
  route,
  capturedAt,
}) {
  if (!Array.isArray(frames) || frames.length !== PROOF_MATRIX.length) {
    throw new Error(`Expected exactly ${PROOF_MATRIX.length} frames, received ${frames?.length ?? 0}`);
  }
  const byKey = new Map(frames.map((frame) => [frame.key, frame]));
  const ordered = PROOF_MATRIX.map((cell) => {
    const frame = byKey.get(cell.key);
    if (!frame) throw new Error(`Missing required frame: ${cell.key}`);
    assertValidPng(frame.pngBuffer, cell.key);
    return { cell, frame };
  });

  const safeTitle = escapeHtml(title);
  const safeSubtitle = escapeHtml(subtitle);
  const safeRoute = route ? escapeHtml(route) : '';
  const safeCapturedAt = capturedAt ? escapeHtml(capturedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '';

  const cellsHtml = ordered
    .map(({ cell, frame }) => {
      const dataUrl = `data:image/png;base64,${frame.pngBuffer.toString('base64')}`;
      const alt = escapeHtml(`${cell.viewport.label} ${cell.viewport.sizeLabel} in ${cell.theme.label}`);
      const isDesktop = cell.viewport.id === 'desktop';
      return `          <figure class="proof-cell ${cell.theme.cellClass}${isDesktop ? ' is-desktop' : ''}" data-cell="${cell.key}">
            <figcaption class="cell-head">
              <span class="cell-vp">${escapeHtml(cell.viewport.label)} <span class="cell-dims">${escapeHtml(cell.viewport.sizeLabel)}</span></span>
              <span class="cell-theme">${escapeHtml(cell.theme.shortLabel)} <span class="cell-ok" aria-label="captured">&#10003;</span></span>
            </figcaption>
            <div class="shot-stage">
              <img class="shot-img" src="${dataUrl}" alt="${alt}" />
            </div>
          </figure>`;
    })
    .join('\n');

  const metaParts = [safeSubtitle];
  if (safeRoute) metaParts.push(`route ${safeRoute}`);
  if (safeCapturedAt) metaParts.push(safeCapturedAt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root {
    --shell: #0f0f10;
    --canvas: #171717;
    --raised: #222222;
    --stroke: #353535;
    --strong: #57534e;
    --ink: #fafaf9;
    --secondary: #d6d3d1;
    --muted: #a8a29e;
    --added: #3fb950;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --shell: #f0efed;
      --canvas: #fafaf9;
      --raised: #f5f5f4;
      --stroke: #e7e5e4;
      --strong: #d6d3d1;
      --ink: #1c1917;
      --secondary: #44403c;
      --muted: #6b6560;
      --added: #1a7f37;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--shell);
    color: var(--ink);
    font-family: 'Space Grotesk', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .sheet {
    max-width: 1380px;
    margin: 0 auto;
    padding: 16px;
  }
  .artifact-proof-card {
    border: 1px solid var(--stroke);
    border-radius: 10px;
    background: var(--raised);
    overflow: hidden;
  }
  .proof-grid-6 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2.15fr);
    gap: 10px;
    padding: 12px;
    background: var(--canvas);
    border-bottom: 1px solid var(--stroke);
    align-items: start;
  }
  @media (max-width: 720px) {
    .sheet { padding: 10px; }
    .proof-grid-6 {
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
      padding: 10px;
    }
  }
  .proof-cell {
    margin: 0;
    border: 1px solid var(--stroke);
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .proof-cell.dark-cell {
    background: #171717;
    border-color: #353535;
    color: #fafaf9;
  }
  .proof-cell.light-cell {
    background: #fafaf9;
    border-color: #d6d3d1;
    color: #1c1917;
  }
  .cell-head {
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .cell-vp { font-weight: 500; }
  .cell-dims { opacity: 0.68; }
  .cell-theme { white-space: nowrap; }
  .dark-cell .cell-ok { color: #3fb950; }
  .light-cell .cell-ok { color: #1a7f37; }
  .shot-stage {
    border-radius: 3px;
    overflow: hidden;
    line-height: 0;
  }
  .dark-cell .shot-stage {
    background: #222222;
    border: 1px solid #353535;
  }
  .light-cell .shot-stage {
    background: #f5f5f4;
    border: 1px solid #e7e5e4;
  }
  .shot-img {
    display: block;
    width: 100%;
    height: auto;
  }
  .artifact-card-foot {
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .foot-meta { min-width: 0; flex: 1; }
  .foot-title {
    font-size: 15px;
    line-height: 22px;
    font-weight: 600;
    color: var(--ink);
  }
  .foot-sub {
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 16px;
    color: var(--muted);
    word-break: break-word;
  }
  .foot-badge {
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 19px;
    font-weight: 600;
    color: var(--added);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <main class="sheet">
    <section class="artifact-proof-card" aria-label="${safeTitle}">
      <div class="proof-grid-6">
${cellsHtml}
      </div>
      <footer class="artifact-card-foot">
        <div class="foot-meta">
          <div class="foot-title">${safeTitle}</div>
          <div class="foot-sub">${metaParts.join(' &middot; ')}</div>
        </div>
        <span class="foot-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> 6/6</span>
      </footer>
    </section>
  </main>
</body>
</html>
`;
}

export async function renderContactSheetPng(html, { width = 1400, chromiumPath } = {}) {
  const browser = await launchBrowser(chromiumPath);
  try {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(
      () => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))),
    );
    const pngBuffer = await page.screenshot({ type: 'png', fullPage: true });
    assertValidPng(pngBuffer, 'stitched contact sheet');
    return pngBuffer;
  } finally {
    await browser.close();
  }
}

export async function generateSurfaceProof({
  url,
  dir,
  route = '/',
  out,
  png,
  title = '6-frame surface proof',
  subtitle = 'Phone 390×844 · Narrow Web 390×844 · Desktop 1440×900 · Stone Dark & Light',
  waitFor,
  waitUntil = 'networkidle',
  timeoutMs = 30_000,
  chromiumPath,
  fullPage = false,
}) {
  const capture = await captureSurfaceFrames({
    url,
    dir,
    route,
    waitFor,
    waitUntil,
    timeoutMs,
    chromiumPath,
    fullPage,
  });

  const html = renderContactSheetHtml({
    frames: capture.frames,
    title,
    subtitle,
    route: dir ? route : undefined,
    capturedAt: capture.capturedAt,
  });

  const outIsPng = typeof out === 'string' && out.toLowerCase().endsWith('.png');
  const htmlPath = out && !outIsPng ? resolve(out) : undefined;
  const pngPath = png ? resolve(png) : outIsPng ? resolve(out) : undefined;

  if (htmlPath) {
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html, 'utf8');
  }

  let pngBuffer;
  if (pngPath) {
    pngBuffer = await renderContactSheetPng(html, { chromiumPath });
    mkdirSync(dirname(pngPath), { recursive: true });
    writeFileSync(pngPath, pngBuffer);
  }

  return {
    html,
    htmlPath,
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    pngBuffer,
    pngPath,
    pngBytes: pngBuffer?.length ?? 0,
    frames: capture.frames,
    capturedAt: capture.capturedAt,
  };
}

function parseArgs(argv) {
  const options = {
    route: '/',
    waitUntil: 'networkidle',
    timeoutMs: 30_000,
    fullPage: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--url') options.url = next();
    else if (arg === '--dir') options.dir = next();
    else if (arg === '--route') options.route = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--png') options.png = next();
    else if (arg === '--title') options.title = next();
    else if (arg === '--subtitle') options.subtitle = next();
    else if (arg === '--wait-for') options.waitFor = next();
    else if (arg === '--wait-until') options.waitUntil = next();
    else if (arg === '--timeout') options.timeoutMs = Number(next());
    else if (arg === '--chromium') options.chromiumPath = next();
    else if (arg === '--full-page') options.fullPage = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node packages/scripts/ui-surface-proof.mjs (--dir <export-dir> | --url <url>) --out <proof.html> [options]',
    '',
    'Options:',
    '  --dir <path>         Serve a local Expo web export directory on 127.0.0.1',
    '  --route <path>       Route to open when serving --dir (default: /)',
    '  --url <url>          Live URL (supports {mode}, {theme}, {viewport} placeholders)',
    '  --out <path>         Output HTML (or PNG if ending in .png) contact sheet path',
    '  --png <path>         Also write a stitched PNG contact sheet to this path',
    '  --title <text>       Card title (default: "6-frame surface proof")',
    '  --subtitle <text>    Card subtitle',
    '  --wait-for <sel>     CSS selector to wait for before each capture',
    '  --wait-until <ev>    Playwright goto waitUntil: load|domcontentloaded|networkidle',
    '  --timeout <ms>       Per-capture timeout in ms (default: 30000)',
    '  --chromium <path>    Explicit Chromium executable path',
    '  --full-page          Capture full scrollable page instead of viewport height',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.out && !options.png) {
    throw new Error('Provide --out <proof.html> and/or --png <proof.png>');
  }
  const result = await generateSurfaceProof(options);
  console.log(
    JSON.stringify({
      frames: result.frames.map((frame) => ({
        key: frame.key,
        viewport: frame.viewport.sizeLabel,
        theme: frame.theme.id,
        bytes: frame.byteLength,
      })),
      htmlPath: result.htmlPath ?? null,
      htmlBytes: result.htmlBytes,
      pngPath: result.pngPath ?? null,
      pngBytes: result.pngBytes,
      capturedAt: result.capturedAt,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
