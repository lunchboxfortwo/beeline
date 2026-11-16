import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkStoneSurfaces } from './check-stone-surfaces.mjs';

for (const colour of ['#14091A', '#14091acc', 'rgb(25, 14, 33)', 'rgba(25, 14, 33, .8)', 'rgb(25 14 33 / 80%)']) {
  it(`rejects a planted legacy surface on mobile, native, web and server: ${colour}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'stone-policy-'));
    try {
      for (const dir of ['apps/mobile/sources/buzz', 'apps/mobile/plugins', 'apps/mobile/public', 'apps/mobile/src-tauri', 'apps/server/src', 'apps/site']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, 'apps/mobile/app.config.js'), '');
      writeFileSync(join(root, 'apps/mobile/src-tauri/tauri.conf.json'), '{}');
      writeFileSync(join(root, 'apps/mobile/sources/buzz/groknight.ts'), readFileSync('apps/mobile/sources/buzz/groknight.ts'));
      for (const file of ['apps/mobile/sources/Error.tsx', 'apps/mobile/plugins/splash.js', 'apps/server/src/page.ts', 'apps/site/index.html', 'apps/site/demo.mjs', 'apps/site/ui.json']) writeFileSync(join(root, file), `background: #F3EEE4; background: ${colour}`);
      assert.equal(checkStoneSurfaces(root).length, 12);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
it('production surfaces keep legacy colours inside the Brass token set', () => {
  assert.deepEqual(checkStoneSurfaces(process.cwd()), []);
});

it('Reproduction STONE-LAUNCH: Android resumes onto Stone behind the splash', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const plugin = require('../../apps/mobile/plugins/android-splash-theme.js');
  const xml = plugin.applyAndroid12SplashTheme(structuredClone(plugin.EXPO_ANDROIDX_ONLY_SPLASH_STYLE));
  const theme = xml.resources.style.find(style => style.$.name === 'AppTheme');
  assert.equal(theme.item.find(item => item.$.name === 'android:windowBackground')._, '@color/splashscreen_background');
  assert.equal(plugin.LIGHT_SPLASH_BACKGROUND.toLowerCase(), '#fafaf9');
  assert.equal(plugin.DARK_SPLASH_BACKGROUND.toLowerCase(), '#171717');
});

it('Reproduction STONE-LAUNCH: the icon launcher hands the Stone splash to MainActivity', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const plugin = require('../../apps/mobile/plugins/withAndroidPushRouting.js');
  const config = plugin({ name: 'Beeline', slug: 'beeline', android: { package: 'app.usebeeline' } });
  const manifest = await config.mods.android.manifest({
    ...config,
    modResults: { manifest: { application: [{ activity: [{ $: { 'android:name': '.MainActivity' } }] }] } },
    modRequest: { introspect: true },
  });
  const launcher = manifest.modResults.manifest.application[0].activity.find(
    activity => activity.$['android:name'] === '.PushNotificationActivity',
  );
  assert.equal(launcher.$['android:theme'], '@style/Theme.App.SplashScreen');
  const gradle = await config.mods.android.appBuildGradle({ ...config, modResults: { contents: 'dependencies {}' } });
  assert.match(gradle.modResults.contents, /implementation\("androidx\.core:core-splashscreen:1\.2\.0"\)/);
  const repeated = await config.mods.android.appBuildGradle(gradle);
  assert.equal(repeated.modResults.contents, gradle.modResults.contents);

  const root = mkdtempSync(join(tmpdir(), 'stone-launcher-'));
  try {
    await config.mods.android.dangerous({ ...config, modRequest: { platformProjectRoot: root } });
    const source = readFileSync(join(root, 'app/src/main/java/app/usebeeline/PushNotificationActivity.kt'), 'utf8');
    assert.match(source, /val splashScreen = installSplashScreen\(\)/);
    assert.ok(source.indexOf('val splashScreen = installSplashScreen()') < source.indexOf('super.onCreate(savedInstanceState)'));
    assert.match(source, /splashScreen\.setKeepOnScreenCondition\s*\{ true \}/);
    assert.ok(source.indexOf('splashScreen.setKeepOnScreenCondition') < source.indexOf('startActivity(destination)'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
