const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transformSync } = require('@babel/core');
const plugin = require('./direct-library-imports.cjs');

const transform = (source, platform = 'web') => transformSync(source, {
  configFile: false, babelrc: false, plugins: [plugin], caller: { name: 'metro', platform },
}).code;

test('loads the same core, wrapped components and provider without the whole barrel', () => {
  const result = transform("import { YStack, Button as Action, TamaguiProvider, useTheme, Text, createTamagui } from 'tamagui'; export const values = [YStack, Action, TamaguiProvider, useTheme, Text, createTamagui];");
  assert.match(result, /import .*setup\.mjs/);
  assert.match(result, /require\("@tamagui\/stacks"\)\.YStack/);
  assert.match(result, /require\("tamagui\/button"\)\.Button/);
  assert.match(result, /require\("tamagui\/provider"\)\.TamaguiProvider/);
  assert.match(result, /require\("@tamagui\/core"\)\.useTheme/);
  assert.match(result, /views\/Text\.mjs/);
  assert.match(result, /createTamagui\.mjs/);
  assert.doesNotMatch(result, /from ['"]tamagui['"]/);
});

test('native private entrypoints retain platform implementations', () => {
  const result = transform("import { Text, createTamagui } from 'tamagui'; export const values = [Text, createTamagui];", 'android');
  assert.match(result, /setup\.native\.js/);
  assert.match(result, /views\/Text\.native\.js/);
  assert.match(result, /createTamagui\.native\.js/);
  assert.doesNotMatch(result, /\.mjs/);
});

test('unknown, namespace and side-effect imports preserve the package contract', () => {
  const result = transform("import { FutureComponent, useTheme } from 'tamagui'; import * as UI from 'tamagui'; import 'tamagui'; export const values = [FutureComponent, useTheme];");
  assert.match(result, /import \{ FutureComponent \} from 'tamagui'/);
  assert.match(result, /import \* as UI from 'tamagui'/);
  assert.match(result, /import 'tamagui'/);
  assert.match(result, /require\("@tamagui\/core"\)\.useTheme/);
});


test('unused components stay unevaluated even when Metro preserves their side effects', () => {
  const first = transformSync("import { YStack, Sheet } from 'tamagui'; export function body() { return YStack; } export function modal() { return Sheet; }", {
    configFile: false, babelrc: false, plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
  }).code;
  const compiled = transformSync(first, {
    configFile: false, babelrc: false,
    plugins: [[require('metro-transform-plugins').inlineRequiresPlugin, { ignoredRequires: ['@tamagui/stacks', 'tamagui/sheet', 'livekit-client', 'posthog-react-native'] }]],
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

test('voice SDK evaluation stays inside the original audio gesture', () => {
  const first = transformSync("import { Room, RoomEvent } from 'livekit-client'; export async function join() { const room = new Room(); room.startAudio(); return RoomEvent; }", {
    configFile: false, babelrc: false, plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
  }).code;
  const compiled = transformSync(first, {
    configFile: false, babelrc: false, plugins: [[require('metro-transform-plugins').inlineRequiresPlugin, { ignoredRequires: ['@tamagui/stacks', 'tamagui/sheet', 'livekit-client', 'posthog-react-native'] }]],
  }).code;
  const steps = [];
  const exports = {};
  new Function('require', 'exports', compiled)(name => {
    steps.push(name);
    return { Room: class { startAudio() { steps.push('audio'); } }, RoomEvent: {} };
  }, exports);
  assert.deepEqual(steps, []);
  exports.join();
  assert.equal(steps[0], 'livekit-client');
  assert.equal(steps[1], 'audio'); // Audio still starts synchronously before join returns.
});

test('an unconfigured analytics client does not evaluate its SDK', () => {
  const first = transformSync("import PostHog, { PostHogProvider } from 'posthog-react-native'; export const client = configured ? new PostHog() : null; export function provider() { return PostHogProvider; }", {
    configFile: false, babelrc: false, plugins: [plugin, '@babel/plugin-transform-modules-commonjs'],
  }).code;
  const compiled = transformSync(first, {
    configFile: false, babelrc: false, plugins: [[require('metro-transform-plugins').inlineRequiresPlugin, { ignoredRequires: ['@tamagui/stacks', 'tamagui/sheet', 'livekit-client', 'posthog-react-native'] }]],
  }).code;
  const loaded = [];
  const run = new Function('require', 'exports', 'configured', compiled);
  const load = name => { loaded.push(name); return { default: class {}, PostHogProvider: 'provider' }; };
  const disabled = {};
  run(load, disabled, false);
  assert.equal(disabled.client, null);
  assert.deepEqual(loaded, []);
  const enabled = {};
  run(load, enabled, true);
  assert.equal(loaded[0], 'posthog-react-native');
  assert.equal(enabled.provider(), 'provider');
});

test('transforms JSX value references after TypeScript types are removed', () => {
  const result = transformSync("import { YStack } from 'tamagui'; type Props = { children?: string }; export const Screen = (props: Props) => <YStack>{props.children}</YStack>;", {
    configFile: false, babelrc: false, filename: 'screen.tsx',
    plugins: [plugin, ['@babel/plugin-transform-typescript', { isTSX: true }], ['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }]],
  }).code;
  assert.match(result, /require\("@tamagui\/stacks"\)\.YStack/);
  assert.doesNotMatch(result, /from ['"]tamagui['"]|type Props/);
});
