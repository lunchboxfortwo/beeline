# Workspace shared assets

The helper now gives every agent in a Workspace on this machine one asset tree at
`$XDG_STATE_HOME/beeline/workspaces/<Workspace digest>/shared-home`. Asset
preparation selects supported package-cache locations, optional pinned harness
and ACP adapter generations, and AVD metadata. Harnesses without a pinnable
adapter and turns where pinning fails use the host's installed adapter. Android tools and system
images continue to use the operator's installed SDK; the helper does not copy
or hash that SDK. Every agent and Room keeps its existing `agent-home` path for harness
sign-in, configuration, sessions, plugin data, and unknown files; resume needs no
transcript migration. Pending approvals remain server scoped. Repository corners
keep their own checkout and build output. For the current shared host emulator
workflow, see [Android device proof](agent-body.md#android-device-proof-from-a-corner).

`workspace-assets.ts` owns the asset layout and `bwrap-sandbox.ts` owns the
mount plan. Asset preparation still selects shared cache locations through the
environment, but sessions no longer bind the Workspace cache writable or
rebind Codex `cache`, `plugins/cache` or Cargo `registry` to that tree. The
former shared-layout parent masks and required asset mounts are removed.
Environment selection alone does not grant write access. Current session write
boundaries and private-cache setup follow the [approval matrix](approval-matrix.md).

Beeline adds no shared pip or Gradle cache override; their defaults follow
the private Room HOME, while inherited custom locations remain unchanged.
Existing Rust, Cargo, Maven, Java, Android NDK, Gradle and other toolchain
settings pass through. The added environment variables select only supported
shared package and harness download caches.

## Capacity and migration

Before optional shared writes, the helper checks for 2 GiB free and creates a
real, fsynced 128 MiB private recovery reserve. A turn uses its existing
private paths when initial shared admission lacks space. If optional tool
pinning later fails, it keeps the shared caches and uses the host adapter.
The helper checks free capacity every 500 ms and releases the reserve when
free space approaches it; observed ENOSPC also releases it. This is best effort:
a private write may race the check, and concurrent writers can consume the
space. The reserve is not a hard quota or a guarantee that a transcript write
will succeed.

Old homes are never removed automatically. The operator command
`beeline cleanup-shared-home` reports only byte-identical files at recognized
download-cache paths whose Workspace has already run the new layout. The
command `beeline cleanup-shared-home --apply` requires a running machine
helper, explicitly stops it, and asks its next startup to inventory again and remove those exact
files before it starts any agent. Sessions, approvals, credentials, unknown
files, and writable AVD data are outside the cleanup allowlist. Empty old
directories may remain. The command waits for the restarted helper's result;
a malformed record or changed cache file is skipped.
The measured 5.8 GiB old `user/avd` tree is dominated by a 4.37 GB
`userdata-qemu.img.qcow2`, which is writable guest state rather than an
identical base image; it is intentionally retained.
Old installed tool directories also remain unless their files are in a
recognized download cache; installation trees can contain local configuration.

## 2026-10-11 disk projection on this machine

The read-only baseline found 77 GiB under `beeline/agents` (76.38 GiB in
`agent-home` roots). The existing corner checkouts are a separate cost. The
four largest plausibly shareable download categories measured across old homes
are:

| Old-home category          | Combined allocated bytes | Largest one-home copy |
| -------------------------- | -----------------------: | --------------------: |
| Codex download cache       |            5,473,710,080 |            35,303,424 |
| Codex plugin package cache |            5,267,750,912 |            30,625,792 |
| npm home cache             |           13,856,993,280 |         1,213,992,960 |
| pnpm home store            |            6,141,247,488 |           924,700,672 |

These categories total **30,739,701,760 bytes**. Keeping only the largest
observed copy of each would use **2,204,622,848 bytes**, a theoretical upper
bound of **28,535,078,912 bytes saved**. The real after value will be higher:
there are multiple Workspaces, the union of packages exceeds the largest one
home, parts of `.npm` are outside the cleanup allowlist, and old private or
unknown files remain. No bytes have been reclaimed on the live helper by this
change. The dry-run command is the measured reclaimable amount after new
turns have warmed the shared cache; it deliberately requires matching content
before promising a byte.

Historical validation of the former writable shared-cache layout used an isolated
`XDG_STATE_HOME`: two same-repo checkouts ran
`npm ci` and the Body TypeScript build concurrently against one npm cache;
two Codex sessions in separate Rooms resumed their own histories while using
one download and plugin cache; two Android emulators reached boot completion
at the same time with separate port leases and writable images. Body sandbox,
capacity, asset, cleanup and retention tests, plus server grant visibility
tests, cover the remaining boundaries.
