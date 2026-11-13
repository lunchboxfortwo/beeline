# Selected repository pill web proof

Captured from the actual ChatRepositoryEditor, NewChatSheet, SelectedRepositoryPill,
RepoList and grammar components bundled for React Native Web with the production
Tamagui configuration. The isolated harness supplies repository responses and
stubs native animation/keyboard/safe-area/haptics, modal confirmations and text-draft
storage. These captures prove web interaction and layout, not Android frame latency.

At a 390 × 844 viewport in Bone and Obsidian:

- Chat info: open Repository with a long selected owner/repo name. The pill wraps;
  Save starts disabled. Press its shared close button: pill disappears and Save
  enables. The None row is absent. Selection remains staged until Save.
- New chat: open Attach a GitHub repository and select the long repository. The
  existing onPickRepository callback fires immediately, while the local selected
  pill appears. Press its close button: the local pill disappears without another
  create callback. This does not cancel an in-flight chat creation. The harness
  keeps the sheet mounted to show this state; successful real creation closes it.
- Both close controls measured 44 × 44 CSS pixels in both themes.

Files ending `selected` precede the clear action; `cleared` follow it. All eight
captures use the same long-name fixture and five repository candidates.

Regression suites: ChatInfoScreen, NewChatSheet and RepoList (26 passing tests);
RoomRepositoryChoice and design/calm lints (19 passing tests). The new select,
clear and empty-state cases fail against the previous implementation. Mobile
typecheck and shared UI component policy also pass.

Reproduction CHAT-REPO-LATENCY-1 remains pending final-head native timing by Claude;
web captures do not establish the cold Android median below 150 ms.
