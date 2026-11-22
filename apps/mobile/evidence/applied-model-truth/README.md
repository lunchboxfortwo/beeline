# Applied model truth: Emberus "Astra" label while running Sol

## Cause found on squire (22 Nov 2026)

- Helper journal: every catalog probe since at least 21 Nov 22:34 local logged `model catalog not posted this activation: model "gpt-6.2-astra" is unavailable` (and the same for `gpt-6.2-sol`). The probe never re-posted, so the server kept the old catalog whose current value was the stamped selection, Astra.
- No `model selection could not be applied` line exists. Live sessions took the silent branch where the selected model is not in the harness catalog and the session runs the harness default (Sol). That branch only wrote a note to the agent, never to the server.
- Agents run the managed Codex adapter (codex-acp 2.6.0 with codex 0.166.0). The operator's own Codex CLI is 0.169.0 and lists `gpt-6.2-astra`. The harness most likely does not offer the 6.2 models to the older bundled Codex. I could not confirm the bundled list directly because a probe needs the account sign-in.

## Screenshots

Production `MembersScreen` and `AgentProfileScreen`, bundled with esbuild (`frame/build.mjs`), fed with the views the server returns for the same agents row: selected `gpt-6.2-astra`, stale catalog current value `gpt-6.2-astra`, session running `gpt-6-sol`. Before uses main d81649a03 sources and main's view; after uses this branch and the view `running-model.integration.test.ts` asserts. Data hooks, navigation and media are stubbed (`frame/stubs.tsx`); no backend.

| | Before | After |
| --- | --- | --- |
| Web, Bone | [before-bone-web.png](before-bone-web.png) | [after-bone-web.png](after-bone-web.png) |
| Web, Obsidian | [before-obsidian-web.png](before-obsidian-web.png) | [after-obsidian-web.png](after-obsidian-web.png) |
| Phone members, Bone | [before-bone-members-android-chrome.png](before-bone-members-android-chrome.png) | [after-bone-members-android-chrome.png](after-bone-members-android-chrome.png) |
| Phone agent sheet, Bone | [before-bone-profile-android-chrome.png](before-bone-profile-android-chrome.png) | [after-bone-profile-android-chrome.png](after-bone-profile-android-chrome.png) |
| Phone members, Obsidian | [before-obsidian-members-android-chrome.png](before-obsidian-members-android-chrome.png) | [after-obsidian-members-android-chrome.png](after-obsidian-members-android-chrome.png) |
| Phone agent sheet, Obsidian | [before-obsidian-profile-android-chrome.png](before-obsidian-profile-android-chrome.png) | [after-obsidian-profile-android-chrome.png](after-obsidian-profile-android-chrome.png) |

Web: headless Chrome at 1280×900. Phone: Chrome on the shared Android emulator (1080×2400, 420 dpi), not the native app build.

Rebuild: `node apps/mobile/evidence/applied-model-truth/frame/build.mjs apps/mobile <out-dir>`, serve `<out-dir>`, open `?theme=bone|obsidian&state=before|after&page=members|profile`.
