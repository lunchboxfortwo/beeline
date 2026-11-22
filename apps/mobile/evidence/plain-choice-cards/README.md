# Plain choice cards: rendered proof

`harness.tsx` renders this branch's real `ChoiceCard` in the real Tamagui Bone and Obsidian themes and fonts. Its rows go through the real phone projection (`readRoomViewMessage` -> `displayRoomMessage`). The synthetic gate card is stored the old way: each option still carries a `consequence`, and the message text is the old system line `@ruby asked <prompt>`.

Panels:
1. **Open gate.** Only the question and the choices "Approve all" and "Not now" show. There are no sub labels, no "@ruby asked" line, no note box and no Skip.
2. **Answered.** The question and "Approve all · picked A · @lunchboxfortwo".
3. **Tap a choice.** The capture taps "Approve all" and the card turns into the answered card (`web-<theme>-tapped.png`).

Files: `web-bone.png`, `web-obsidian.png` (before the tap), `web-bone-tapped.png`, `web-obsidian-tapped.png` (after the tap).

Capture output (411 px wide, 2x):

```
bone open: question and choices only | Approve fixes from today's card? / 09:06 / A / Approve all / B / Not now
bone answered: question and choices only | Approve fixes from today's card? / 09:06 / Approve all · picked A · @lunchboxfortwo
bone tapped: question and choices only | Approve fixes from today's card? / 09:06 / Approve all · picked A · @lunchboxfortwo
obsidian open: question and choices only | Approve fixes from today's card? / 09:06 / A / Approve all / B / Not now
obsidian answered: question and choices only | Approve fixes from today's card? / 09:06 / Approve all · picked A · @lunchboxfortwo
obsidian tapped: question and choices only | Approve fixes from today's card? / 09:06 / Approve all · picked A · @lunchboxfortwo
```

## Compared with the approved mock

The card has the same content as mock panels 1 and 3: one question, the choices in words, and the answered line. Two differences come from the app's existing card design, which this change does not alter:
- The choices keep their letter plates (A, B), and none is pre-filled. The mock drew plain buttons with the first one filled.
- The agent's face sits beside the question in the header. The mock had a separate "Ruby · morning card" line.

## Repeat the capture

From `apps/mobile`:

```sh
EXPO_OVERRIDE_METRO_CONFIG="$PWD/evidence/plain-choice-cards/metro.cjs" CI=1 npx expo start --port 19251 --web --offline
# in another shell
PCC_PLAYWRIGHT="$PWD/../../node_modules/playwright-core/index.mjs" node evidence/plain-choice-cards/capture-web.mjs evidence/plain-choice-cards
```

It prints one line per card and exits 1 if a card shows a sub label, a raw outcome key, a note box, Skip or the "asked" line.
