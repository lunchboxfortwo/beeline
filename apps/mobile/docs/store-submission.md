# Store submission

Operator runbook for Google Play and the App Store. Unified release
builds and submits Android to Play beta when an owner explicitly dispatches
`next` with `store_track=beta`. Store production submissions are separate
from RC promotion. Routine OTA releases use `store_track=none`.

The Google Play developer account is Moon Rice Limited. Keep that account, its
service account key and the App Store Connect API key outside this repository.

## Inputs the owner supplies once

### Google Play

1. **Repository secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`** — the full JSON key of
   a Google Cloud service account (IAM → Service accounts → Keys → JSON). Paste
   the file's contents as the secret value. Every Play workflow reads only this
   secret and stops with one plain line when it is missing. The workflows mint
   the access token themselves with the self-signed JWT flow
   (`packages/scripts/play-token.mjs`, node only): the key's private key signs a JWT that
   `oauth2.googleapis.com/token` exchanges for a token. The IAM Service Account
   Credentials API (`iamcredentials.googleapis.com`, which
   `google-github-actions/auth` requires) is not enabled in the project and is
   not needed; only the Google Play Android Developer API must be enabled.
2. **Play Console invite for that service account** — Play Console → Users and
   permissions → Invite new users → the service account's email address, with
   app-level permissions on Beeline (`app.usebeeline`):
   *Release to production* (production store operations), *Release to testing
   tracks* (explicit beta releases), and *Manage store presence* (the explicitly
   authorized listing sync).

   The Google Play Android Developer API must be enabled on the service
   account's Cloud project.

### TestFlight

3. **Repository secrets `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`,
   `EXPO_ASC_API_KEY_P8`** — an App Store Connect API key with the *App Manager*
   role: the key id, the issuer id, and the `.p8` file encoded with
   `base64 -w0 AuthKey_<id>.p8`. The `store_ios` job writes the decoded key to a
   runner-temp file and points `EXPO_ASC_API_KEY_PATH` at it before the build
   (eas-cli needs it to create or repair the App Store provisioning profile
   non-interactively) and for the `production` submit profile in `eas.json`
   (team `89KT3SWYAF`, app `6803948500`).
4. **EAS-managed iOS signing** — run once from an operator machine:

   ```sh
   cd apps/mobile
   eas credentials --platform ios
   ```

   and let EAS create or upload the distribution certificate and App Store
   provisioning profile for `app.usebeeline.mobile` (Build Credentials →
   `production-ci` → Distribution Certificate). This step cannot be skipped:
   eas-cli 22.2.0 never validates or creates a distribution certificate in
   `--non-interactive` mode, with or without the API key, and a workflow run
   without one fails at the build step with `Credentials are not set up. Run
   this command again in interactive mode.` and prints this command. The
   `production-ci` build profile uses those remote credentials; the
   local-credentials `production` profile stays for operator-machine builds.

Both stores also need the existing `EXPO_TOKEN` repository secret.

## Signing choice: EAS credentials, never the sideload keystore

The **sideload** keystore for `npm run apk:release` lives in the
`ANDROID_SIDELOAD_*` repository secrets and the Trusty Squire vault (see
`apps/mobile/android-signing/README.md` for the 2026-10-15 rotation).
Rotating it requires existing sideload installs to be uninstalled and
reinstalled. Play builds never use it. The `store_android` job
runs `eas build --profile production --platform android`, whose AAB is signed by the
**EAS-managed upload key**, and Google Play App Signing owns the app signing key.
If the upload key is ever lost, Play's upload-key reset flow applies; the
sideload keystore is not involved either way.

### App link fingerprints for the `app.usebeeline` record

Both `assetlinks.json` copies (`apps/site/.well-known/assetlinks.json`
and `apps/mobile/public/.well-known/assetlinks.json`) currently carry only the
sideload signing certificate. The Play App Signing certificate for the new
`app.usebeeline` record does not exist until the first AAB is uploaded, so its
SHA-256 fingerprint must be appended to the same `sha256_cert_fingerprints`
array afterwards — Play Console → Test and release → Setup → App signing → *App
signing key certificate*. Until that is done, verified `https://usebeeline.app`
links open in the browser for Play installs; sideload installs are unaffected.

## Runtime compatibility stamp

A store binary carries the same `runtimeVersion` as the OTA updates it may
later receive, and that value is pinned by hand in `app.config.js`. A store
release therefore ships whatever pin is on the release commit; it needs no
action here.

What does need action is a native change (dependency, config plugin,
permission). The `NATIVE FINGERPRINT` gate fails that PR until the pin is
bumped, and a bumped pin means the phones on the old pin can only cross over by
installing a new binary — so the bump has to be followed by a store submission
(and, for the OTA canary, one `eas build --profile beta-apk`). Check the stamp
with

```sh
cd apps/mobile && npm run fingerprint:check
```

## Commands

```sh
# Regenerate the derived Play metadata after editing apps/mobile/store/
node packages/scripts/sync-play-metadata.mjs
node packages/scripts/sync-play-metadata.mjs --check     # what the release's store leg runs first

# Prove the Play API scripts without a service account
npm run test:play
PLAY_DRY_RUN=1 PACKAGE_NAME=app.usebeeline METADATA_DIR=apps/mobile/fastlane/metadata/android LANGUAGE=en-US \
  bash packages/scripts/play-publish-listing.sh

# Request a next Android beta build with store_track=beta through the audited
# dispatch_release tool. Use the store consoles for production submissions.
```

## Recovering an already uploaded build

Merging this fix cannot change an existing Play upload. For the reported
versionCode **142**, firstmate must inspect its current release and publishing
state. The historical upload log already records it on production as completed
with
automatic review submission, before the later build-review regression. Verify
that current state rather than assuming promotion is needed. If it is no longer
on production with completed status, reuse that uploaded bundle in a production
release and start a full rollout. If it is already a completed production
release but is saved without review submission,
send **only that build** for review in Publishing overview. Preserve pending
listing edits unless the owner explicitly commands their publication. Do not
re-upload versionCode 142: Play version codes cannot be reused for a new upload.
Availability follows Google's review and any Console managed-publishing hold;
a successful upload alone does not make it downloadable. No Play state is
changed by this code change.

## What the store leg does

`store_track=none` is the OTA default. An explicit `store_track=beta` in
the next workflow selects the Android native job. A beta build failure fails
the selected component.

**`mobile_native_android`** (Play beta) checks the app version
(`scripts/check-release-version.cjs`) and that the Play metadata is current, runs
`eas build --local --profile production-ci --platform android --non-interactive`,
produces the AAB locally, verifies package name, `versionName` and
`versionCode` with bundletool against the package version and the EAS build
record and rejects a debug signer, uploads the AAB as a run artifact, mints a
short-lived Play access token from the service account, then runs
`packages/scripts/play-publish.sh` (create edit → upload bundle → `tracks.update` with
`track: production` by default (explicit beta override), `status: completed`, notes from
`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` or `default.txt`
→ commit). Releases upload only the build to Play by default. Listing text and
images are never uploaded unless the release is explicitly dispatched with
`publish_listing=true` (default `false`) on an explicit workspace owner
command. The cited command must include a dedicated imperative line such as
"Publish the Play listing"; admin commands and routine release orders cannot
unlock listing uploads. The default path compares the committed listing with Play, discards the read edit, and logs that differences
were not uploaded; comparison errors only warn and do not fail the release.
The upload step records every locale's listing text and all eight Play image
types in the exact build edit before uploading. The **Enforce the Play listing
lock before committing the build** CD step re-reads that edit immediately before
commit and stops on any changed text/image, naming each locale and field/image
type. Failure to read or validate the edit/baseline also stops before commit.
Repo-vs-live differences alone remain advisory; the gate compares the edit
against its pre-upload state. Explicit owner listing consent unlocks this gate.

After the listing gate passes, the build edit commits normally, without
`changesNotSentForReview`, and is sent for review automatically. The commit
uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW` to preserve an existing review.
A refused review submission fails the job; there is no fallback that saves an
unsent build and reports success. Play production uses `completed` status and
no `userFraction`, so approval enables full rollout rather than a staged rollout.
See Google's [commit parameters](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)
and [release status](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks#Status).

The build commit never uploads listing metadata. When explicitly authorized,
`packages/scripts/play-publish-listing.sh` separately reads the live listing and skips
unchanged text and image hashes. Changed listings clear and re-upload each
image type in filename order. `publish_listing` permits uploading changes;
it does not force re-uploading matching assets. That listing operation retains
the same `ERROR_IF_IN_REVIEW` commit as the build, so an explicitly authorized
listing publish cannot cancel a build already in review.

For an explicitly authorized iOS store submission, use the `production-ci`
profile in `apps/mobile/eas.json` to build the IPA and the `production`
submit profile to upload it to TestFlight. Use App Store Connect to attach
the processed build and submit it for App Review. The release owner's
approved production runtime pin and store version must match the IPA.

## Listing source and derived metadata

`apps/mobile/store/` is the human-reviewable package (copy under
`listing/en-US/`, graphics under `assets/`, `screenshots/`).
`apps/mobile/fastlane/metadata/android/en-US/` is derived from it by
`packages/scripts/sync-play-metadata.mjs`, committed, and read verbatim by the Play
scripts. The sync validates every asset against the Play rules (512×512 32-bit
icon, 1024×500 24-bit feature graphic, 2–8 screenshots with sides between 320
and 3840 px and a long side at most twice the short side, text limits). The
App Store description uses the same full description; no App Store metadata
push exists yet, so listing text there is entered in App Store Connect by hand.

## Human checks before the first upload

- Approve the listing copy and `store/` graphics in this repository.
- Deploy and open `https://usebeeline.app/privacy` from the tracked
  `apps/site/privacy/index.html` page.
- Enter the answers in `store/questionnaires/` into the current Play Console
  and App Store Connect forms, then re-check any changed form language.
- Confirm the PostHog build environment choice. The app sends no analytics
  without `EXPO_PUBLIC_POSTHOG_API_KEY`; when it is set, its lifecycle and OTA
  events must remain declared in the store answers.
- Confirm that Android FCM notifications and iOS notification capabilities are
  enabled for the submitted native binary.
