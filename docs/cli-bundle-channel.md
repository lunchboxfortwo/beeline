# Beeline helper update channel

> **Download routing:** `apps/infra/helper-downloads/` owns the Cloudflare `/dl/*`
> route. It streams public R2 objects at the existing URLs. Activate
> that route using its [rollout instructions](../apps/infra/helper-downloads/README.md)
> before the first release using this workflow. The marketing site stays on
> GitHub Pages; helper publication does not deploy Pages.

Helpers boot a verified staged release or the verified active release from local disk, then check for the newest release on a pushed release notice and once after socket registration from `https://usebeeline.app/dl/manifest.json`.
The manifest, relative platform archives and `.sha256` paths remain unchanged,
including `/dl/next/manifest.json`. The installer at `/install` and `/install.sh`
still fetches `/dl/beeline-bootstrap.mjs` and its checksum through the same route.
The recovery bootstrap migrates old installations forward to one native supervised helper.

## Following next

User helpers follow latest at `/dl/manifest.json`. Set
`BEELINE_RELEASE_CHANNEL=next` in the native helper service environment to
follow `/dl/next/manifest.json`. `BEELINE_UPDATE_MANIFEST_URL` remains the
highest-priority override. For the squire host's first transition, firstmate
should set **both**:

```ini
BEELINE_RELEASE_CHANNEL=next
BEELINE_UPDATE_MANIFEST_URL=https://usebeeline.app/dl/next/manifest.json
```

The URL override also works in the currently installed older helper, before
it has the channel selector. Apply those variables to the squire's existing
native service configuration and its recovery/update shell; changing a shell
alone does not change an already running service. Firstmate applies this host
configuration after merge; this PR does not touch the host. Removing both
settings returns to latest on the next ordinary update reconciliation.

The R2 prefixes `dl/` (latest) and `dl/next/` retain independently validated
helper bytes; the rolling GitHub prereleases `helper-update-channel` and
`helper-update-channel-next` retain secondary copies.
The route selects the channel from the path, independently of the static
website deployment. A next release never republishes the stable website.
Next bundles carry an rc version,
for example `v0.1.184-rc.3`. Latest promotion
rebuilds/stamps bundles from that rc commit with `v0.1.184` and publishes them
to `/dl/manifest.json`; the next manifest keeps serving the rc. Ordinary helper
notices merely trigger a manifest check; each helper resolves its own channel.
The new helper rechecks even when latest promotes a build already announced
for `next`. Helpers predating this change can suppress that second notice:
reconnect or run `npx usebeeline@latest update` once after the first latest
promotion if necessary.
The CLI's `next` npm tag is separate from these authoritative bundle channels;
`npx usebeeline@latest update` continues to recover using the configured bundle
manifest, independently of npm processing. The rc npm package publishes with `--tag next`;
the rebuilt final package uses npm's default latest tag through OIDC, without
an npm token or a dist-tag operation.

## Release authority and durable storage

For every new next rc and latest promotion,
`.github/actions/daemon-leg/action.yml` combines install-verified native
`linux-x64`, `darwin-arm64`, and `darwin-x64` bundles under the release's exact
version and source SHA. Linux builds on the standard hosted `ubuntu-22.04` runner, alongside native
Apple-silicon and Intel builds on the existing `macos-15` and `macos-15-intel`
runner types. The Linux job also compiles the CLI. The final helper job waits
for all three, combines their verified outputs and publishes once; it performs
no native compilation. A retry whose exact identity already serves at the download URL
skips bundle rebuilding and promotion (see [the release pipeline](release-pipeline.md)).
Input-keyed native binaries may be restored from Actions cache; a miss builds
them from the pinned upstream. Full-bundle install proof still runs. Native
cache entries are never published on the public Releases page.
Channel policy selects helper rebuilding even when helper source inputs are
unchanged, so every new identity gets its own version stamp.
Its promote phase validates and publishes the exact bundle directory through
`packages/scripts/pages-channel.mjs`, then runs `packages/scripts/verify-pages-update.mjs` against
the public download URL. The legacy script names are retained. The helper job
has no Pages permission, environment, artifact upload or deployment wait.

Publication uploads every archive, checksum, recovery bootstrap, Mac build input
and manifest to the `beeline-downloads` R2 bucket under `dl/` (latest) or
`dl/next/` (next), using the same client and Cloudflare credentials as desktop
publication. The Worker streams `https://downloads.usebeeline.app/dl/...`
without credentials and bypasses caches for these mutable channel URLs.
The rolling `helper-update-channel` and `helper-update-channel-next` GitHub
prereleases retain secondary copies for authenticated build carry/downloads;
public downloads do not depend on GitHub repository visibility. Helpers retain
their existing checksum verification and leave the installed version untouched
if publication is interrupted; rerunning the helper leg repairs a partial upload.
Each destination receives its manifest last, after all other channel files.

The helper job serializes channel publication. The website job separately
holds `usebeeline-pages` while deploying only static marketing files,
associations and installers. It ignores checkout `apps/site/dl/` and never downloads
or republishes helper archives. Website deployment runs when selected even
when the helper is also selected, since the helper no longer deploys the site.

No new binaries are committed to Git (#647). The static website and Release
assets are independent of the dev machine and Actions artifact retention.
Build runners still run the existing release jobs; moving those runners is a
separate task from retiring the retired development services.

## Consumer and verification contract

The manifest uses schemaVersion 1, with `sourceCommit`, `version`, and
`bundles["linux-x64"]`, `bundles["darwin-arm64"]`, and
`bundles["darwin-x64"]` entries containing `file`, `sha256`, `bytes`, `node`,
`commit`, `version`, and `verified: true`. Every bundle and the top-level identity
must match the unified release identity. Source commit is the helper's primary
comparison; the unified release's `vX.Y.Z-rc.N` or final `vX.Y.Z` is the version fallback.

The verifier requires the exact expected manifest, checks every SHA sidecar,
and executes the production `SelfUpdateManager` in a disposable prefix seeded
with an older identity. It fetches and hashes the actual tarball, extracts it,
smoke-tests the CLI, activates the stable anchor, checks the installed identity,
and runs the installed `beeline --version`. Release bundle verification does not
pair, start a production daemon, or touch an existing helper. The older identity
is a fixture that forces a same-release redeploy through the real updater path,
not a claim of fleet restart. Release-time smoke proves the published package
and manifest. Fleet uptake is asynchronous post-release observability and never
blocks delivery.

The PR gate `MAC HELPER ACCEPTANCE` runs on the repository's self-hosted Intel
Mac. Its filter is the macOS-specific sources alone — never the run-everything
fallback — so an ordinary `apps/body`, shared-package, or unmapped-path change
never queues behind that one machine. It performs a fresh installer run,
exercises launchd crash restart and a bootout/bootstrap cycle
(the closest non-destructive CI equivalent to a logout/login), verifies the
restart-after-any-exit and explicit native-stop contract, pairs against the in-process monolith, observes a
Room answer, and exercises `open_corner` with the deterministic ACP fixture. The
native Apple-silicon bundle is proven only by the release's own `helper_macos`
leg - or, on a retry reusing a merged artifact, by the attempt that built those
exact bytes - which runs the same installer/ACP/CodeGraph bundle proof on
GitHub's hosted arm64 Mac runner; no pull-request gate rebuilds it.

macOS has no bubblewrap namespaces. The helper therefore uses the existing
`bwrap`-unavailable fallback: it logs `harness OS sandbox UNAVAILABLE`, runs ACP
children without an OS-level filesystem sandbox, and relies on the permission
handler for the Room read-only rule. This is the same behavior as a Linux host
without a working `bwrap`; this release adds no substitute sandbox.

Having no bubblewrap also makes one product behavior reachable on macOS that a
Linux host with a working `bwrap` never sees: a granted command run in a
TOP-LEVEL Room is refused with `ROOM_SANDBOX_UNAVAILABLE`, because a Room run
is sandboxed or nothing (C94 fail-closed). Corner grants are unaffected — they
run on the host by design — so `run_granted_command` works in corners and
refuses in Rooms on every Mac.

Linux uses `Type=notify` and `Restart=always`; macOS uses launchd `KeepAlive`.
Neither uses a helper watchdog. After preparation and the intake drain, the
helper closes the machine link and exits in the same turn. The native manager
cleans up remaining processes and restarts the helper; local broker clients or
asynchronous runtime teardown cannot hold up that exit. Native readiness and
individual agent readiness remain separate.
The macOS helper log is `~/Library/Logs/Beeline/helper.log`; launchd does not
provide Linux's bounded journal rotation.

And the helper is supervised in the per-GUI-session domain, `gui/<uid>`, not a
system domain: the LaunchAgent loads when that user LOGS IN, not at boot, and
`launchctl enable|bootstrap gui/<uid>/…` fails outright when no Aqua session
exists. So a Mac needs a real logged-in session — autologin on a headless Mac
mini, or a human at the keyboard — for `beeline connect`/`beeline start` to
install the job at all, and for the helper to come back after a reboot; over
SSH with nobody logged in, pairing reports `its daemon did not start` and there
is no non-launchd fallback. The `gui/` domain is deliberate, not incidental:
Trusty Squire drives a real Chrome in that session, and Linux's
`systemctl --user` carries the analogous `loginctl enable-linger` requirement.

Redirects are refused in the update proof: the canonical download URL must
serve the bytes directly. The Worker follows GitHub's asset redirect internally.
The helper proof verifies the exact manifest, sidecars and production updater
without a Pages propagation loop.

## Recovery and the first update from an old release

`npx usebeeline@latest update` runs a small recovery entry independent of the
installed body. It downloads, verifies checksum, Node requirements and imports,
then installs the stable launcher. It normalizes flat installs, real anchor
directories, old symlinks, broken forwarders and recorded Node paths. It disables
and stops legacy per-agent units before enabling the sole native helper. The
new unit has no exit-79 exception; an empty helper stays alive. Any exit restarts
unless the operator explicitly stops the native service.

The CLI that is already executing on an old machine still has its old behavior.
Use the new npm recovery entry for a dead or broken old install. After the first
forward migration, both installed `beeline update`/`beeline start` and npx select
the current release, ensure the native helper is running, and wait for a live
process-generation acknowledgment that every enabled agent is serving. A failed
agent is named with its reason. `update` preserves stopped agents; `start --all`
or `start --agent <key>` explicitly re-enables them. `update --status` is a local,
read-only observation; `--check` checks only the published artifact.

`connect` reuses the installed CLI and never prepares or requests a helper
release when one is already installed. It writes the paired agent's runtime,
asks the running helper to converge, and waits for that agent alone. A new
machine installs the helper first and starts it after the runtime is written.
The helper rejects a requested version older than its loaded release,
including comparisons between final and rc releases.

Legacy helper records sign the one-time authenticated
`/v1/auth/daemon/migrate-legacy` server route with their existing identity. The
server requires current owner and Workspace membership, and denies revoked or expired daemon credentials and repeat completed migrations. The exchange preserves agent identity,
policy, homes and sessions. Revoked or unrecognized identities show `needs
reconnect`; other agents continue serving.

One release transaction prepares in a private worker while intake stays open.
It hands over at a quiet gap. Preparation and handoff each use the same
three-minute timeout, disarmed while waiting for idle. A prepared release stays
staged throughout busy periods and boots on the next restart if no quiet gap
arrives. `beeline update --force` hands off while busy, journaling interrupted
commands through the same path as a server minimum. If an operation cannot finish, Beeline cancels it,
records the failure in local helper status and keeps the current release
serving; it does not schedule a retry. A later explicit release notification
or update request can start a new attempt. Pending wakes stay on the server
for the successor to claim. Server minimums validate the prepared version and
journal interrupted commands immediately before handing over.

Failed handoffs clear their matching staged selection under the install lock.
Bootstrap consumes a staged selection before activation, so a failed activation
that returns to the previous anchor cannot select the failed stage again.

A stable `<prefix>/lib/beeline-bootstrap.mjs` and recorded Node path select the
body before importing it. Verified local startup never waits for publication or
downloads; freshness reconciliation runs while the helper serves.
`<prefix>/lib/beeline` remains an atomically renamed
symlink into immutable `beeline-releases/<id>`. Startup serves the last verified
release while publication freshness is still unconfirmed;
it never disables the native restart owner. There is no rollback coordinator
or detached production fallback.

The manifest's `recovery` entry pins the small bootstrap's file, checksum and
size. Bundle merging and the public helper channel preserve
and validate those exact bytes alongside the platform archives.

## Isolated acceptance

Never run lifecycle tests against a live user's install or native helper. Body
tests set private HOME/config/state paths and an unreachable user bus.
`lifecycle-test-guard.ts` refuses real paths, symlink aliases, and an unmocked
manager outside the disposable native-proof container. Native Linux proof lives
in `packages/scripts/helper-proof/`: build the real bundle and npm tarball first, then
run `bash packages/scripts/helper-proof/run-linux.sh`. It uses its own PID namespace,
PID 1, user manager, local HTTP/WebSocket server and deterministic ACP harness.
The container is removed at completion. See the acceptance evidence in
[helper simplification](helper-simplification.md).

Run `bash packages/scripts/helper-proof/run-linux.sh packages/scripts/helper-proof/prove-update-handoff.mjs`
for the update handoff regression. It retains a real local broker client while
an idle helper stages a verified release, proves the successor answers through
both agent connections with `WatchdogSec=0`, and proves a successor startup
smoke-test failure preserves the serving process and connections.

## Daemon update invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

### Daemon self-update and CLI bundle

- **`<prefix>/lib/beeline` is the active bundle anchor**, a symlink into `lib/beeline-releases/<id>` swung by rename(2) (`self-update.ts`). Never suggest `npx beeline` (an unrelated package); recovery is `npx usebeeline update`.
- **Update restarts are silent and exit directly.** `runMachineHelper` closes the machine link with `HELPER_UPDATE_CLOSE_CODE`/`HELPER_UPDATE_CLOSE_REASON`, then exits synchronously without awaiting agent teardown; `DaemonAgentSession` releases presence without an offline notice only for that signal. Unexpected loss still notices the owner (`machine-offline.test.ts`, `daemon-live.test.ts`, `machine-update-handoff.test.ts`). Release delivery pushes helpers only (`release-notify.ts`).
- **Linux handovers use a fixed one-second native restart delay.** `native-helper.ts` renders no escalating restart steps. The running helper refreshes the installed unit with `daemon-reload`, without restarting the service. `recovery.startup.test.ts` proves verified staged/active boot makes no publication request; `systemd.test.ts` covers unit convergence.
- **Routine release notices preserve active turns.** `ReleaseNotifier` pushes published helper releases; `MachineLink` reconciles the manifest once after first registration, with no periodic check. `ReleaseTransaction` dispatches preparation and waits for an idle event without pausing admission or discarding the staged boot selection. Its single three-minute timeout bounds preparation and handoff separately, never idle waiting. Server minimums and explicit forced updates journal and interrupt immediately before the verified handoff. Late asynchronous completions cannot restart the helper after cancellation (`managed-update.startup.test.ts`, `machine-update-handoff.test.ts`, `agent-runtime.startup.test.ts`). Installation remains checksum verification plus atomic activation.
- `unified-release.yml` builds Linux and Mac bundles in parallel; `.github/actions/daemon-leg/` collects and promotes their verified outputs; `launchd.ts` supervises macOS (no bwrap). `https://usebeeline.app/dl/manifest.json` stays pinned; runbook `docs/cli-bundle-channel.md`.

### Installed bundle retention

`self-update.ts` records the displaced bundle as `previousReleaseId`. Explicit
activation and the serving machine helper prune the release directory under the install lock,
keeping the current bundle and one previous bundle for rollback. A staged update
and a still-loaded predecessor remain protected only during the update handoff.
Bootstrap activation defers pruning until the helper serves, so old bundle
deletion cannot delay successor import.
Old installations without rollback metadata select one recent predecessor once;
later installs use the recorded previous version. Historical release symlinks
are unlinked without following their targets. Regression coverage:
`storage-bloat.regression.test.ts` and `self-update-layout.test.ts`.
