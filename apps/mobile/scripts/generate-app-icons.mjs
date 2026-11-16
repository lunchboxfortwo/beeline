#!/usr/bin/env node
// Requires librsvg (rsvg-convert) and ImageMagick (convert), like the brand generator.
// Geometry comes from the existing vector; no tracing or recoloring raster pixels.
// node apps/mobile/scripts/generate-app-icons.mjs [--check]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mobile, '../..');
const images = join(mobile, 'sources/assets/images');
const canonical = readFileSync(join(images, 'mark.svg'), 'utf8');
const path = canonical.match(/<path\b[^>]*\bd="([^"]+)"/)[1];
const geometry = JSON.parse(readFileSync(join(mobile, 'sources/buzz/beeline-mark.json'), 'utf8'));
if (path !== geometry.path) throw new Error('Canonical vector and mark geometry disagree');
const ink = '#1c1917';
const paper = '#f5f5f4';
const outputs = new Map();
const svg = (body, title) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="1024" height="1024">\n  <title>${title}</title>\n  ${body}\n</svg>\n`);
// Center the vector bounds (124.745, 123) on the icon without changing its path.
const mark = (fill = ink) => `<g transform="translate(-4.745 -3)"><path fill="${fill}" d="${path}"/></g>`;
const background = `<rect width="240" height="240" fill="${paper}"/>`;
const regular = svg(background + mark(), 'Beeline app icon — Stone ink on Stone paper');
// Android adaptive layers are 108dp, with the standard visible mask spanning
// 72dp. A 2/3 foreground scale preserves the regular mark's 61% visible height.
// Its full bounds also fit inside the central 66dp safe circle.
const adaptive = (fill) => svg(`<g transform="translate(120 120) scale(0.666666667) translate(-120 -120)">${mark(fill)}</g>`, 'Beeline adaptive foreground — canonical loop in the safe zone');
const active = svg(background + mark() + `<circle cx="211" cy="29" r="13" fill="${ink}"/>`, 'Beeline active favicon');
const render = (source, size) => execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size)], { input: source });
const put = (relative, data) => outputs.set(join(root, relative), data);
const image = (name, data) => outputs.set(join(images, name), data);
for (const name of ['icon.svg', 'icon-light.svg']) image(name, regular);
image('icon-adaptive.svg', adaptive(ink));
image('icon-monochrome.svg', adaptive('#ffffff'));
image('icon-adaptive-background.svg', svg(background, 'Beeline adaptive background — Stone paper'));
image('favicon-active.svg', active);
const master = render(regular, 1024);
for (const name of ['icon.png', 'icon-ios.png', 'icon-light.png', 'favicon.png']) image(name, master);
image('icon-adaptive.png', render(adaptive(ink), 1024));
image('icon-adaptive-monochrome.png', render(adaptive('#ffffff'), 1024));
image('icon-adaptive-background.png', render(svg(background, 'Stone paper'), 1024));
for (const [file, size] of [
    ['apps/mobile/fastlane/metadata/android/en-US/images/icon.png', 512],
    ['apps/mobile/store/assets/store-icon-512.png', 512],
    ['apps/mobile/store/assets/ios-app-icon-1024.png', 1024],
    ['apps/site/icon-512.png', 512],
    ['apps/site/apple-touch-icon.png', 180],
]) put(file, render(regular, size));
const scratch = mkdtempSync(join(tmpdir(), 'beeline-stone-icons-'));
try {
    for (const [file, source] of [['apps/site/favicon.ico', regular], ['apps/mobile/public/favicon-active.ico', active]]) {
        const png = join(scratch, 'favicon.png');
        writeFileSync(png, render(source, 256));
        put(file, execFileSync('convert', [png, '-define', 'icon:auto-resize=48,32,16', 'ico:-']));
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
const check = process.argv.includes('--check');
const stale = [];
for (const [file, data] of outputs) {
    if (check) {
        try { if (!readFileSync(file).equals(data)) stale.push(file); }
        catch { stale.push(file); }
    } else writeFileSync(file, data);
}
if (stale.length) throw new Error(`App icons are stale. Regenerate with this script:\n${stale.join('\n')}`);
console.log(`App icons: ${outputs.size} files ${check ? 'match' : 'generated from'} the canonical vector.`);
execFileSync(process.execPath, [join(mobile, 'scripts/generate-tauri-icons.mjs'), ...(check ? ['--check'] : [])], { stdio: 'inherit' });
