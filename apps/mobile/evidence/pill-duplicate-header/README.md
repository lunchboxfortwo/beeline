# Pill duplicate header

Before/after captures of an expanded single-source GitHub event run (three merged PRs: `#217`, `#214`, `#218`) and an expanded mixed run (two GitHub PR merges, an agent-to-agent message, and a Beeline thread event) in Bone and Obsidian themes across native Android and web.

## Native Android phone captures

Captured on the shared Android emulator (`emulator-5554`, `1080×2400` at `420 dpi`, Android API 36, Expo Go `55.0.7`) using an isolated Expo Go fixture mounting the production `PillRow` component (`origin/main` `0bcb8eade` for before; branch head for after), `IdentityMark`, `GitHubMark`, `TranscriptNavigationRow`, and `TranscriptLine` inside `TamaguiProvider` (`light_brass` Bone and `dark_brass` Obsidian) with the real Space Grotesk and IBM Plex Mono fonts. Expanded captures were taken after real native `adb shell input tap` presses on both rendered pills, with `uiautomator` verifying the duplicate `GitHub, 19:33` heading is present before and absent after while the mixed `GitHub, 21:02` and `Beeline, 21:11` headings remain in both.

Files:
- `before-phone-{bone,obsidian}.png`
- `after-phone-{bone,obsidian}.png`

## Web captures

Captured in headless Chromium (`960×720`) rendering the same production `PillRow` component (`origin/main` `0bcb8eade` for before; branch head for after) in Bone (`light_brass`) and Obsidian (`dark_brass`).

Files:
- `before-web-{bone,obsidian}.png`
- `after-web-{bone,obsidian}.png`
