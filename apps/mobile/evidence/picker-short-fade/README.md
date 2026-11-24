# Command picker: fade only lists that scroll

Reproduction R1: in a thread, type `@<agent> /restar`. Before, the picker shows one row,
/restart, with "Restart this agent" faded by the bottom edge. After, the description is at
full contrast. A list longer than the card still fades its bottom edge.

- `android-picker-fade.png`: Android emulator (API 36, 1080x2400), the app's own thread
  composer with the keyboard open, Bone (top) and Obsidian (bottom). Columns: `@rig-agent /restar`
  on main, `@rig-agent /restar` with this change, `@rig-agent /` (9 commands) with this change.
- `web-picker-one-after.png`: web (Chrome, 390x844), one command after, Bone and Obsidian.
  Web never drew the fade (`fadingEdgeLength` is Android-only), so it is unchanged.

How it was run: two Hermes release APKs, one built from main and one from this branch, under
separate package ids with a throwaway signing key. Both talked to a local monolith started by
`packages/scripts/latency-rig/run-local.sh` and seeded by `seed-local.mjs`. A local-only SQL
seed gave `rig-agent` seven advertised commands (the app adds /restart and /login) and created
the thread `picker-fade-proof`. Themes were set in Settings → Appearance. No production
Workspace was used, and the seed and build patches were not committed.
