# UI Vertical Alignment Sweep — Visual Proof

Rendered at `390px` mobile viewport (`@2x`) using the production Tamagui components (`IndexRow`, `PrLifecycleCard`, `grammar.tsx`, `TranscriptCard`, `OnboardingFrame`, `ChoiceOption`, `ChoicePlate`, `MonoMarkdown`, `WorkBoard`), Stone theme tokens (`light_stone` and `dark_stone`), and real Space Grotesk / IBM Plex Mono fonts, comparing post-merge base `origin/main` (`681366c48`) against the PR head (`41fb7e527`).

## Captures

| Theme | Before (`origin/main` `681366c48`) | After (PR #183 `41fb7e527`) | Approved Mock (Stone) |
| --- | --- | --- | --- |
| Light Stone (default) | [before-light-stone.png](before-light-stone.png) | [after-light-stone.png](after-light-stone.png) | [approved-mock-stone.png](approved-mock-stone.png) |
| Dark Stone | [before-dark-stone.png](before-dark-stone.png) | [after-dark-stone.png](after-dark-stone.png) | [approved-mock-stone.png](approved-mock-stone.png) |

## Measured DOM Vertical Deltas (Chrome `getBoundingClientRect`, Medium text)

| Surface | Before (`681366c48`) | After (`41fb7e527`) |
| --- | --- | --- |
| 1. `TranscriptNavigationRow` (`Opened thread lightweight-math-rendering >`) | chevron `+4.5px` | `0px` |
| 2. `grammar.tsx` `Row` (`Schedules & wakes`) | lead `-0.5px`, chevron `-1.5px` | `0px` (Small, Medium, Large) |
| 3a. `TranscriptCard` single-line header (`Grant request`) | stamp `-2px`, chevron `-3.5px`, dismiss `+10.5px` | `0px` (`44×44` hit target) |
| 3b. `TranscriptCard` multi-line header (`wrapTitle` + `subline` + `onDismiss`) | stamp `-2px`, chevron `-3.5px`, dismiss `+10.5px` | `0px` (Medium & Large, `44×44` hit target preserved) |
| 3c. `TranscriptCard` `CardRow` (`Waiting`) | state `-2px`, chevron `-1.5px` | `0px` |
| 4. `OnboardingFrame` `Choice` | chevron `-4px` | `0px` |
| 5a. `ChoiceOption` (inset wash preserved: `top +13px`, `borderRadius: 6px`) | label `-2.5px`, votes `-4.5px` | `0px` |
| 5b. `ChoicePlate` | label `-5px`, votes `-5px` | `0px` |
| 6. `MonoMarkdown` task checkbox | `+0.5px` (drifts at Large) | `0px` |
| 7. `WorkBoard` `SectionHead` (`44pt` hit target) | chevron `+6px`, title `+6px` | `0px` |
