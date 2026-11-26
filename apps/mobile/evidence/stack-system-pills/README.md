# Stack system pills

Before/after captures of consecutive system transcript notices (`@lunchboxfortwo removed @emberus` followed by `@crayon joined · invited by @lunchboxfortwo`) in both folded and expanded states, in Bone and Obsidian themes across native Android and web.

## Native Android phone captures

Captured on the shared Android emulator (`emulator-5554`, `1080×2400` at `420 dpi`, Android API 36, Expo Go `55.0.7`) using an isolated Expo Go fixture mounting an inverted native `FlatList` with the production `foldPrLifecycleRuns`, `foldPillRuns` (`main` `b95a425f7` for before; branch head for after), `LedgerEntry`, `TranscriptPills`, `PillRow`, `LedgerSystemLine`, and `IdentityMark` components inside `TamaguiProvider` with the real Space Grotesk and IBM Plex Mono fonts. Expanded captures were taken after real native `adb shell input tap` presses on the rendered pills.

Files:
- `before-phone-{bone,obsidian}-{folded,expanded}.png`
- `after-phone-{bone,obsidian}-{folded,expanded}.png`

## Web captures

Captured in headless Chromium (`1100 px` width) rendering the production `foldPrLifecycleRuns`, `foldPillRuns`, `TranscriptPills`, `PillRow`, `LedgerSystemLine`, and `IdentityMark` components across folded/expanded consecutive system notices and a mixed agent/system/GitHub run.

Files:
- `before-web-{bone,obsidian}.png`
- `after-web-{bone,obsidian}.png`
