import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Artwork and the brand reference document are not UI surface declarations.
const artwork = new Set(['apps/server/src/agent-avatar.ts', 'apps/server/src/face-templates.generated.json', 'web/brand/index.html']);
const tokens = 'apps/mobile/sources/buzz/groknight.ts';
const roots = ['apps/mobile/sources', 'apps/mobile/plugins', 'apps/mobile/public', 'apps/server/src', 'web'];

export function checkStoneSurfaces(root) {
  const source = readFileSync(join(root, tokens), 'utf8');
  const colours = new Set([...source.matchAll(/(?:bg\w+|appCanvas|appTile|appCard|avatarGround|buttonPrimaryFill|buttonPrimaryText):\s*['"](#[\da-f]{6})['"]/gi)]
    .map(match => match[1].toLowerCase())
    .filter(value => !['#171717', '#222222', '#2c2c2c', '#242424', '#fafaf9', '#f5f5f4', '#e7e5e4', '#f0efed', '#1c1917'].includes(value)));
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const file = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) { if (!['node_modules', 'vendor', 'email-art'].includes(entry.name)) walk(path); continue; }
      if (!/\.(?:tsx?|[cm]?js|json|css|html)$/.test(file) || /\.(?:test|spec|gen)\./.test(file) || file === tokens || artwork.has(file)) continue;
      scan(file, readFileSync(path, 'utf8'));
    }
  }
  function scan(file, text) {
    // Exported React Native markup uses rgb(); overlays also use alpha hex.
    // Compare the underlying ink so either spelling gets the same policy.
    for (const match of text.matchAll(/#[\da-f]{6}(?:[\da-f]{2})?\b|rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*[\d.%]+)?\s*\)/gi)) {
      const colour = match[1] === undefined ? match[0].slice(0, 7).toLowerCase()
        : '#' + match.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('');
      if (!colours.has(colour)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      errors.push(`${file}:${line}: legacy surface ${match[0]} belongs only in the Brass token set`);
    }
    if (/themeName\([^,\n]+,\s*['"]brass['"]\)/.test(text))
      errors.push(`${file}: forced Brass theme bypasses the saved colour set`);
  }
  for (const dir of roots) walk(join(root, dir));
  // The adaptive launcher icon is artwork; activity/splash configuration is not.
  scan('apps/mobile/app.config.js', readFileSync(join(root, 'apps/mobile/app.config.js'), 'utf8').replace(/adaptiveIcon:\s*\{[\s\S]*?\n\s*\},/, ''));
  scan('apps/mobile/src-tauri/tauri.conf.json', readFileSync(join(root, 'apps/mobile/src-tauri/tauri.conf.json'), 'utf8'));
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkStoneSurfaces(resolve(process.argv[2] ?? '.'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Stone surface policy passed');
}
