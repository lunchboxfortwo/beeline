#!/usr/bin/env node
// Explicit device regression gate. Never runs implicitly on a shared emulator.
// Usage: node scripts/prove-android-push-tap.mjs <emulator> <payload.json> <mapping.txt> <output-dir>
// payload.json: { data: <firebasePushMessage(...).data>, header: '#Room', text: <exact message>, state: 'background'|'killed' }
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [serial, payloadFile, mappingFile, outDir] = process.argv.slice(2);
assert.match(serial ?? '', /^emulator-\d+$/, 'Pass an explicitly authorized emulator');
assert.ok(payloadFile && mappingFile && outDir, 'Pass payload, R8 mapping and local evidence directory');
const output = resolve(outDir);
mkdirSync(output, { recursive: true });
const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
assert.ok(payload.data?.messageId && payload.header && payload.text);
assert.equal(payload.data.workspaceId, 'bee11e00-0000-4000-8000-000000000105',
  'Use only the Beeline Review fixture Workspace');
assert.ok(['background', 'killed'].includes(payload.state));
const appId = 'app.usebeeline';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const shell = (...args) => adb('shell', args.map(quote).join(' '));
assert.match(shell('id'), /uid=0\(root\)/, 'Native injection requires a rooted test emulator');
const mapping = new Map([...readFileSync(mappingFile, 'utf8').matchAll(/^(\S+) -> (\S+):$/gm)]
  .map(([, original, obfuscated]) => [original, obfuscated]));
const classes = [
  'com.google.firebase.messaging.RemoteMessage',
  'expo.modules.notifications.notifications.model.RemoteNotificationContent',
  'expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger',
  'expo.modules.notifications.notifications.model.NotificationRequest',
  'expo.modules.notifications.notifications.model.Notification',
  'expo.modules.notifications.notifications.interfaces.INotificationContent',
  'expo.modules.notifications.notifications.interfaces.NotificationTrigger',
].map(name => mapping.get(name) ?? name);
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
assert.ok(sdk, 'ANDROID_HOME is required');
const source = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/AndroidPushReplay.java');
execFileSync('javac', ['-cp', join(sdk, 'platforms/android-36/android.jar'), '-d', output, source]);
execFileSync(join(sdk, 'build-tools/36.0.0/d8'), [
  '--lib', join(sdk, 'platforms/android-36/android.jar'), '--output', output, join(output, 'AndroidPushReplay.class'),
]);
const remoteDex = '/data/local/tmp/beeline-push-tap-replay.dex';
adb('push', join(output, 'classes.dex'), remoteDex);
// The caller first opens the Room list. HOME keeps its task in Recents, which
// is essential: an empty-task launch missed the live R1 regression.
shell('input', 'keyevent', 'KEYCODE_HOME');
// Wait for Android's UI-idle handshake, not an elapsed-time delay, before
// delivering. Delivery while the app is still RESUMED is a foreground case.
shell('uiautomator', 'dump', '/data/local/tmp/beeline-push-tap-home.xml');
if (payload.state === 'killed') {
  shell('am', 'kill', appId);
  assert.equal(spawnSync('adb', ['-s', serial, 'shell', 'pidof', appId]).status, 1,
    'The app process must be dead before native notification delivery');
}
adb('logcat', '-c');
const injection = [appId, ...classes, ...Object.entries(payload.data).map(([key, value]) => `${key}=${value}`)];
shell('env', `CLASSPATH=${remoteDex}`, 'app_process', '/system/bin', 'AndroidPushReplay', ...injection);
shell('cmd', 'statusbar', 'expand-notifications');
const dump = name => {
  const remote = `/data/local/tmp/beeline-push-tap-${payload.data.messageId}-${name}.xml`;
  const result = shell('uiautomator', 'dump', remote);
  assert.match(result, /UI hierchary dumped to:/, 'Android must produce a fresh accessibility dump');
  const xml = shell('cat', remote);
  writeFileSync(join(output, `${name}.xml`), xml);
  return xml;
};
const unescape = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const nodes = xml => [...xml.matchAll(/<node\s[^>]*>/g)].map(([tag]) =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)])));
const shade = nodes(dump('notification'));
const notification = shade.find(node => node.text === payload.data.message);
assert.ok(notification, 'The real native notification must be visible before tapping');
const bounds = notification.bounds.match(/\d+/g).map(Number);
shell('input', 'tap', String((bounds[0] + bounds[2]) >> 1), String((bounds[1] + bounds[3]) >> 1));
// The killed app briefly has no accessibility root while its activity opens.
// Wait for the target's native viewability report, rather than sampling that
// transition or reusing a failed dump. Fresh message IDs cannot match old logs.
writeFileSync(join(output, 'landing-event.txt'), adb('logcat', '-m', '1', '-e',
  `TRANSCRIPT.TARGET.VISIBLE.*${payload.data.messageId}`, '-s', 'ReactNativeJS:I'));
const landing = nodes(dump('landing'));
// The one post-event dump also waits for UI idle, including shade dismissal.
writeFileSync(join(output, 'landing.png'), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p']));
writeFileSync(join(output, 'logcat.txt'), adb('logcat', '-d', '-s',
  'ReactNativeJS:V', 'PushTapProbe:V', 'ActivityTaskManager:I'));
// A Room-list preview is not the message: require its conversation header and
// an exact standalone transcript body, with measured onscreen bounds.
assert.ok(landing.some(node => node.text === payload.header), `Expected conversation ${payload.header}`);
assert.ok(landing.some(node => node.text === payload.text && node.bounds !== '[0,0][0,0]'),
  'Expected the exact notification message in the transcript');
assert.match(readFileSync(mappingFile, 'utf8'),
  /^    expo\.modules\.notifications\.notifications\.NotificationManager INSTANCE -> INSTANCE$/m,
  'The minified APK must retain the strong singleton root for Expo tap delivery');
console.log(`PASS: ${payload.state} tap opens ${payload.header} at ${payload.data.messageId}`);
