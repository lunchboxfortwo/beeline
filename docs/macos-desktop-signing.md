# macOS desktop signing and notarization

The squire release controller dispatches `.github/workflows/mac-desktop.yml`
on a GitHub-hosted macOS runner. Its downloadable `Beeline-universal.dmg`
must be signed with the Moon Rice Limited Developer ID, notarized, stapled,
and checked with `codesign`, `spctl`, and `stapler` before publication.
Missing credentials fail this build; there is no unsigned fallback. The
controller requires successful notarization and verification steps before
downloading the artifact and verifies its updater signature locally.

The separate `.github/workflows/desktop.yml`, used by the hosted unified
release and tester dispatches, retains its optional signing policy. Trusted
in-repo preview builds exercise the signed path when all credentials are
present, while retaining their separate preview identity. Dev builds are
intentionally unsigned. Fork previews and production builds with missing
credentials run fully unsigned; no partial credential set reaches Tauri. Both
the macOS job summary and unified release report say **macOS artifact UNSIGNED:
signing secrets absent**. Once every credential is present, signing,
notarization, stapling, and strict verification are mandatory; any failure
fails the build.

## One-time Apple setup

The Apple Developer Program Account Holder must:

1. Open **developer.apple.com → Certificates, Identifiers & Profiles →
   Certificates**, create a **Developer ID Application** certificate for Moon
   Rice Limited, and install it with its private key in Keychain Access.
2. In Keychain Access, export that certificate and private key as a
   password-protected `.p12`. Use a unique strong export password.
3. Base64-encode the `.p12` without line breaks and store the result as the
   GitHub Actions repository secret `APPLE_CERTIFICATE`:

   ```sh
   base64 -i DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
   ```

4. Store the `.p12` export password as the repository secret
   `APPLE_CERTIFICATE_PASSWORD`.
5. Store the certificate identity as `APPLE_SIGNING_IDENTITY`. It must be
   exactly:

   ```text
   Developer ID Application: Moon Rice Limited (89KT3SWYAF)
   ```

The App Store Connect API key is shared with the existing iOS release. Its
issuer must have access to notarize software for this team. Keep these existing
repository secrets populated:

| Secret | Value |
| --- | --- |
| `EXPO_ASC_KEY_ID` | App Store Connect API key ID |
| `EXPO_ASC_ISSUER_ID` | App Store Connect issuer ID |
| `EXPO_ASC_API_KEY_P8` | Base64-encoded contents of `AuthKey_<key-id>.p8` |

To encode the API private key on macOS:

```sh
base64 -i AuthKey_KEYID.p8 | tr -d '\n' | pbcopy
```

Add repository secrets at **GitHub → Settings → Secrets and variables →
Actions**. Never commit the `.p12`, its password, or the `.p8` file.

## CI contract

Both desktop workflows map the stored Apple credentials to these build
variables:

- `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` import the `.p12` into a
  temporary keychain.
- `APPLE_SIGNING_IDENTITY` pins the expected Developer ID Application identity.
- `APPLE_API_KEY`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH` authenticate
  `notarytool` with the App Store Connect key.

Tauri signs the app with the hardened runtime. Its build runs without the
notarization variables so the workflow submits only the outer `.dmg` to
`notarytool`; that submission covers the app inside it. The workflow staples
the disk image, prints the submission's notarization log ID, and verifies the
exact app and disk image that will be published.

`mac-desktop.yml` also uses the repository's permanent
`TAURI_UPDATER_PUBLIC_KEY` and `TAURI_UPDATER_PRIVATE_KEY` secrets, with
`TAURI_UPDATER_PRIVATE_KEY_PASSWORD` for an encrypted private key, for its
production updater configuration and signed updater archive. The public key
must match the controller's local key used for verification; see the [release credential
contract](./release-pipeline.md#local-recovery-legs-during-an-actions-outage).

No entitlements file is currently required. The app is not App Sandbox-bound,
outbound network access needs no entitlement in this distribution model, and
WKWebView does not need JIT entitlements on macOS. Add an entitlements file only
when a future native capability demonstrably requires one.

Run the local contract checks with:

```sh
node --test packages/scripts/desktop-signing.test.mjs
npm run lint:workflows
```
