// Exercise the actual theme write path with an unavailable Android activity.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const closed = "Call to function 'ExpoSystemUI.setBackgroundColorAsync' has been rejected.\n→ Caused by: The current activity is no longer available";
const unexpected = new Error('Invalid system background color');
const state = { failures: [new Error(closed), unexpected], reports: [], colors: [] };
globalThis.__systemBackgroundProof = state;
const stubs = {
  'react-native': "export const Platform={OS:'android'}; export const Appearance={addChangeListener(){}};",
  'react-native-unistyles': 'export const StyleSheet={configure(){}};export const UnistylesRuntime={setTheme(){},setRootViewBackgroundColor(){}};',
  './theme': `const theme={colors:{groupped:{background:'proof-color'}}};export {
    theme as boneLargeTheme,theme as boneSmallTheme,theme as boneTheme,
    theme as obsidianLargeTheme,theme as obsidianSmallTheme,theme as obsidianTheme};`,
  'expo-system-ui': `export async function setBackgroundColorAsync(color){const s=globalThis.__systemBackgroundProof;
    s.colors.push(color);const error=s.failures.shift();if(error)throw error;}`,
  './buzz/sentry': 'export function captureMobileError(scope,error){globalThis.__systemBackgroundProof.reports.push({scope,error});}',
  './buzz/android-navigation-bar': 'export async function setAndroidNavigationBarStyle(){}',
  './utils/layoutClass': 'export const LAYOUT_BREAKPOINTS={};',
  './sync/persistence': "export const loadLocalSettings=()=>({appearance:'dark',uiSize:'medium'});",
  './buzz/android-launch-appearance': 'export function applyEffectiveAndroidLaunchAppearance(){}export function pinAndroidLaunchAppearance(){}',
  './buzz/app-appearance-seed': "export const resolveAppAppearance=()=> 'dark';export function seedAppAppearanceFromSystem(){}",
};
try {
  const bundle = await build({
    stdin: { contents: "export { setAppDisplay } from './apps/mobile/sources/unistyles.ts';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
    plugins: [{ name: 'native-activity-stand-in', setup(build) {
      build.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'proof' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'proof' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  const theme = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.reports, []);
  theme.setAppDisplay('light', 'medium');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].scope, 'system-background');
  assert.equal(state.reports[0].error, unexpected);
  theme.setAppDisplay('dark', 'medium');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.colors.length, 3);
  assert.equal(state.reports.length, 1);
  console.log('Demonstrated SENTRY-MOBILE-5: startup swallows the destroyed-activity rejection; an Appearance change reports a different failure; the next theme change still applies.');
} finally { delete globalThis.__systemBackgroundProof; }
