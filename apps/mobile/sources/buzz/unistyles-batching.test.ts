import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { resolve } from 'node:path';
import ts from 'typescript';

// Exercise the installed dependency, including the patch applied at mobile install.
const source = readFileSync(resolve(process.env.UNISTYLES_TEST_PACKAGE ?? 'node_modules/react-native-unistyles', 'src/web/css/state.ts'), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const browserFrames of [true, false]) it(`style additions and removals batch before the next browser paint (frames=${browserFrames})`, async () => {
  // This fingerprint exemption must never hide a native dependency change.
  const patch = readFileSync('patches/react-native-unistyles+3.1.1.patch', 'utf8');
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(match => {
    assert.equal(match[1], match[2]);
    return match[1];
  });
  assert.equal(paths.length, 3);
  const { ignorePaths } = createRequire(resolve('package.json'))('./fingerprint.config.js');
  for (const path of paths) assert.ok(ignorePaths.includes(path), `fingerprint must exclude installed web file ${path}`);
  for (const path of paths) assert.match(path, /^node_modules\/react-native-unistyles\/(src|lib\/(module|commonjs))\/web\/css\/state\.(ts|js)$/);
  const writes: string[] = [];
  let renderedTextWrites = 0;
  const style = {
    set innerText(value: string) { renderedTextWrites++; writes.push(value); },
    set textContent(value: string) { writes.push(value); },
  };
  const exports: Record<string, any> = {};
  const frames: Array<() => void> = [];
  const context = {
    ...(browserFrames ? { requestAnimationFrame: (flush: () => void) => frames.push(flush) } : {}),
    exports,
    isServer: () => false,
    document: { getElementById: () => style },
    queueMicrotask,
    hyphenate: (value: string) => value,
    convertUnistyles: (value: unknown) => value,
    convertToCSS: (hash: string, values: Record<string, unknown>, state: any) => {
      for (const [propertyKey, value] of Object.entries(values)) state.set({ className: hash, propertyKey, value });
    },
  };
  vm.runInNewContext(compiled, context);
  const css = new exports.CSSState({ runtime: {} });
  for (let i = 0; i < 30; i++) css.add(`row${i}`, { color: 'red' });
  assert.equal(writes.length, 0, 'adding styles must not rebuild the sheet per style');
  await Promise.resolve();
  if (browserFrames) {
    css.add('yielded', { color: 'green' });
    assert.equal(writes.length, 0);
    assert.equal(frames.length, 1, 'yielded additions in a frame share one update');
    frames.shift()!(); // Browser runs frame callbacks before painting.
  }
  assert.equal(writes.length, 1);
  assert.equal(renderedTextWrites, 0, 'stylesheet writes must not use the layout-aware text setter');
  assert.match(writes[0], /\.row29\{color:red;\}/);
  css.remove('row0');
  css.add('new', { color: 'blue' });
  await Promise.resolve();
  if (browserFrames) frames.shift()!();
  assert.equal(writes.length, 2);
  assert.doesNotMatch(writes[1], /\.row0\{/);
  assert.match(writes[1], /\.new\{color:blue;\}/);
});
