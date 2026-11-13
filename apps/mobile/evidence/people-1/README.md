# Reproduction PEOPLE-1

The phone tab bar showed "Peopl" instead of "People" at large text sizes.

## Reproduced

Android emulator, API 36, 1080×2400, 420 dpi. Installed Beeline 0.2.22 release build from main, system font scale raised step by step (`installed-app-font-scales-before.png`, top to bottom):

- 1.15: "Settings" wraps to "Setting / s".
- 1.3: "Settings" wraps to "Settin / gs".
- 1.5: "People" wraps to "Peopl / e", the reported bug.
- 2.0: Chats, People and Settings all wrap.

## Demonstrated

`harness.tsx` renders main's `TabBar` (`TabBar.main.tsx`, a verbatim copy from `eab26f2b5`) above this branch's real `TabBar`, in the real Tamagui themes and fonts, at text scales 1, 1.2 (app Medium and Large), 1.5 and 1.8. Rows are labelled `main · scale N` and `pr · scale N`. `metro.cjs` swaps only `expo-router` for an inert router, so the bar mounts without the app's navigation tree.

- Android (`android-{bone,obsidian}-{top,bottom}.png`; the earlier side-by-side `bone-before-after.png`, `obsidian-before-after.png` show the same): at 1 and 1.2 main and pr match. At 1.5 main wraps "Setting / s"; at 1.8 it wraps "Peopl / e" and "Settin / gs". pr keeps every label on one line and shrinks only the label that does not fit. `capture-android.py` output, Android 36, 1080×2400, 420 dpi, system font scale 1.0:

```
bone|obsidian bar-main-1, bar-pr-1, bar-main-1.2, bar-pr-1.2: every label on one line
bone|obsidian bar-main-1.5: WRONG Settings(2 lines)
bone|obsidian bar-pr-1.5:   every label on one line
bone|obsidian bar-main-1.8: WRONG People(2 lines) Settings(2 lines)
bone|obsidian bar-pr-1.8:   every label on one line
```
- Web (`web-bone.png`, `web-obsidian.png`): main and pr rows are identical at every scale. Web has no shrink-to-fit, so the one-line rule is native only; on web it would have cut labels to "Peo…" at 1.8.

### Repeat the web capture

From `apps/mobile`:

```sh
EXPO_OVERRIDE_METRO_CONFIG="$PWD/evidence/people-1/metro.cjs" CI=1 npx expo start --port 19249 --web --offline
# in another shell
node evidence/people-1/capture-web.mjs evidence/people-1
```

It prints one line per bar (`full labels on one line` or `WRONG …`) and exits 1 if any pr bar clips or wraps.

### Repeat the Android capture

Gradle writes inside the included plugin builds under `node_modules`. In a corner whose `node_modules` is a read-only mount, build from a writable copy first (`rsync -a apps/mobile <copy>/apps/`, `chmod -R u+rwX <copy>/apps/mobile/node_modules`, then symlink `<copy>/node_modules` and `<copy>/packages` to the repository root ones), and run the commands below from that copy.

```sh
cd apps/mobile
CI=1 npx expo prebuild --platform android --no-install
sed -i -e 's#updates.ENABLED" android:value="true"#updates.ENABLED" android:value="false"#' \
  -e 's#android:authorities="app.usebeeline\.#android:authorities="work.beeline.proof.people1.#g' android/app/src/main/AndroidManifest.xml
sed -i "s#applicationId 'app.usebeeline'#applicationId 'work.beeline.proof.people1'#" android/app/build.gradle
sed -i 's#"package_name": "app.usebeeline"#"package_name": "work.beeline.proof.people1"#' android/app/google-services.json
BEELINE_PROOF_ENTRY="$PWD/evidence/people-1/harness.tsx" \
EXPO_OVERRIDE_METRO_CONFIG="$PWD/evidence/people-1/metro.cjs" \
ANDROID_HOME=/home/lunchbox/android-sdk NODE_ENV=production \
  android/gradlew -p android :app:assembleRelease \
  --init-script "$PWD/evidence/people-1/harness.gradle" \
  --no-daemon -PreactNativeArchitectures=x86_64 --max-workers=2
ADB="adb -H 127.0.0.1 -P 5037 -s emulator-PORT"
$ADB install -r android/app/build/outputs/apk/release/app-release.apk
python3 evidence/people-1/capture-android.py --adb "$ADB" --out evidence/people-1
```

`harness.gradle` selects the harness entry; the `sed` lines install it as `work.beeline.proof.people1` with its own provider names and Firebase client, so the emulator's Beeline app stays untouched. The capture keeps the system font scale as found (1.0 here); the harness applies the text scales itself. It prints one line per bar from UIAutomator bounds and exits 1 if any pr label wraps.

Build identity for the committed Android captures: the APK was built from this commit's tree with the commands above. Its SHA-256 was `cef9becad48b948a3c1b49ac38e9d84d53d3c1ceb5cb2804d1c2115333d7b9b0` (signing and build paths make a rebuild's hash differ; the capture output is the check).
