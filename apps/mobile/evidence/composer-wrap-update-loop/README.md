# Web composer crashes when typed text reaches the wrap point

## Reproduced

The setup was the web app (Expo web, react-native-web) against the design-audit fixture server, viewed in headless Chrome at 1440 × 900 @2x.

1. In a Room with several agent members, type this into the composer one key at a time:
   `@grok_bot with @dots, @muse and @gemini: build a medieval castle tower-defense game.`
2. At the 69th character the text reaches the end of the first line. The composer is replaced by "Conversation mode could not start" with Retry, and the toast reads "Maximum update depth exceeded". See `before-desktop-crash.png`.
3. The typed draft survives the crash, so reopening the Room crashes it again until the draft is cleared.

React's stack names `textarea` → `TextInput` → `UnistylesComponent` → `ConversationComposerContent`.

## Cause

The fault was traced in the browser by logging every ref attach, every content-size report and the textarea's computed style.

- `ConversationComposer` passed the growing height into the Unistyles style array, `{ height: inputHeight, maxHeight }`. Each time that height changed, the textarea rendered without its stylesheet rule. Its computed style became `font-family: -apple-system…` and `line-height: normal`, instead of Space Grotesk and 20px.
- At the wrap point, Space Grotesk needs two lines (`scrollHeight` 40) and the default font fits on one (`scrollHeight` 32).
- RN-web reads `scrollHeight` inside its ref callback, and that ref re-attaches on every render here. The readings therefore alternated 40, 32, 40, 32 with the same text (69 characters) and the same width (572px).
- Each reading set `composerHeight` in `ChatSurfaceComposer`, which changed the style and caused the next reading. React stopped the loop after its nested-update limit.

The @-mentions only lengthen the message; any text whose wrap differs between the two fonts loops.

## Fix

The fix is in `ConversationComposer.tsx` and applies to the web only. iOS and Android are unchanged.

- The changing height is no longer in the Unistyles style array. A layout effect sets `height` and `maxHeight` on the textarea element, so its stylesheet rule never changes while typing.
- RN-web's `onContentSizeChange` is not passed to the web TextInput. A second layout effect reads `scrollHeight` and `scrollWidth` after commit, when the height is in place. It reports to `onContentSizeChange` only when the size changes, or once for a replaced input (a new `inputRevision`), which matches RN-web's report on attach.

Both parts are needed. Moving only the height out of the style array still loops on mount, because RN-web's attach-time reading comes before the layout effect sets the height.

## Demonstrated

The fixture and the message are the same as in the reproduction.

| Check | Desktop 1440 × 900 | Phone 390 × 844 |
| --- | --- | --- |
| Crashing message types to the end | yes (`after-desktop-two-lines.png`) | yes (`after-phone-two-lines.png`) |
| Field height at the wrap | 40 (two lines) | 80 |
| Long message (four lines) | 80, grows (`after-desktop-long.png`) | 115, the maximum, then scrolls |
| Height after Send | 26, back to one line (`after-desktop-sent.png`) | 26 |
| Message sent, with every mention as a tag | yes, "Sent to @dots, @gemini, @grok_bot, @muse" | yes |
| Console exceptions | none | none |

## Checks

The checks were run in a working copy of `origin/main` 4a9d2a262 with the same `ConversationComposer.tsx` change.

- `tsc --noEmit -p apps/mobile/tsconfig.json` passed clean.
- `vitest run sources/components/buzz "sources/app/(app)/beeline/chat"` passed: 39 files, 390 tests.

The vitest suite runs in the `node` environment and cannot lay out a textarea, so the browser runs above are the regression evidence for this change.
