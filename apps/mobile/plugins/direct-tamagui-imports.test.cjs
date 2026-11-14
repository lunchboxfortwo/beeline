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
  assert.match(result, /import \{ YStack \} from "@tamagui\/stacks"/);
  assert.match(result, /import \{ Button as Action \} from "tamagui\/button"/);
  assert.match(result, /import \{ TamaguiProvider \} from "tamagui\/provider"/);
  assert.match(result, /import \{ useTheme \} from "@tamagui\/core"/);
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
  assert.match(result, /import \{ useTheme \} from "@tamagui\/core"/);
});
