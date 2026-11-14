const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('@babel/core');
const plugin = require('./direct-tamagui-imports.cjs');

const transform = (source, platform = 'web') => transformSync(source, {
  configFile: false, babelrc: false, plugins: [plugin], caller: { name: 'metro', platform },
}).code;

test('loads the same core, wrapped components and provider without the whole barrel', () => {
  const result = transform("import { YStack, Button as Action, TamaguiProvider, useTheme, Text, createTamagui } from 'tamagui';");
  assert.match(result, /import .*setup\.mjs/);
  assert.match(result, /YStack = require\("@tamagui\/stacks"\)\.YStack/);
  assert.match(result, /Action = require\("tamagui\/button"\)\.Button/);
  assert.match(result, /TamaguiProvider = require\("tamagui\/provider"\)\.TamaguiProvider/);
  assert.match(result, /useTheme = require\("@tamagui\/core"\)\.useTheme/);
  assert.match(result, /views\/Text\.mjs/);
  assert.match(result, /createTamagui\.mjs/);
  assert.doesNotMatch(result, /from ['"]tamagui['"]/);
});

test('native private entrypoints retain platform implementations', () => {
  const result = transform("import { Text, createTamagui } from 'tamagui';", 'android');
  assert.match(result, /setup\.native\.js/);
  assert.match(result, /views\/Text\.native\.js/);
  assert.match(result, /createTamagui\.native\.js/);
  assert.doesNotMatch(result, /\.mjs/);
});

test('unknown, namespace and side-effect imports preserve the package contract', () => {
  const result = transform("import { FutureComponent, useTheme } from 'tamagui'; import * as UI from 'tamagui'; import 'tamagui';");
  assert.match(result, /import \{ FutureComponent \} from 'tamagui'/);
  assert.match(result, /import \* as UI from 'tamagui'/);
  assert.match(result, /import 'tamagui'/);
  assert.match(result, /useTheme = require\("@tamagui\/core"\)\.useTheme/);
});


test('existing Metro inline requires leave unused components unevaluated', () => {
  const first = transformSync("import { YStack, Sheet } from 'tamagui'; export function body() { return YStack; } export function modal() { return Sheet; }", {
    configFile: false, babelrc: false, plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
  }).code;
  const compiled = transformSync(first, {
    configFile: false, babelrc: false,
    plugins: [require('metro-transform-plugins').inlineRequiresPlugin],
  }).code;
  const loaded = [];
  const exports = {};
  new Function('require', 'exports', compiled)(name => {
    loaded.push(name);
    return { YStack: 'stack', Sheet: 'sheet' };
  }, exports);
  assert.equal(loaded.length, 1); // The original setup side effect remains eager.
  assert.match(loaded[0], /setup\.mjs$/);
  assert.equal(exports.body(), 'stack');
  assert.equal(loaded.at(-1), '@tamagui/stacks');
  assert.equal(loaded.includes('tamagui/sheet'), false);
  assert.equal(exports.modal(), 'sheet');
  assert.equal(loaded.at(-1), 'tamagui/sheet');
});
