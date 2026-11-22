# Live turn status

Human approval: lunchboxfortwo requested visible working state, live completed steps, and simple status text, then instructed “build it. Give it to emberus” (message `4fb68eb9bb0cfc105e91269aa983126472983b430627b1758f7b7c60fcf069c6`). The current thread brief approves these changes without a mock.

The screenshots render the production ThreadBar, ThreadTitleBlock, ThreadLine, TurnProgressLine and TurnStepsLine, with real Tamagui themes and fonts. The surrounding conversation and composer are local fixtures. Before uses the original component sources at commit `d36b8d2babb2dc47d85d3a4ff7bdec4c103d7d44`; after uses the changed sources. Both represent a reply posted while the harness is still running. Before has no running receipt or steps; after retains working and receives completed steps. The browser proof asserts the existing fold grows from two steps to three while all three working sentences remain visible.

`light_brass` is Bone; `dark_brass` is Obsidian. `web` images use a desktop viewport. `phone` images use a narrow browser viewport. `android` images are actual screenshots of the existing shared Android emulator running this built web fixture in Chrome; these are not native-app or signed-in production screenshots. Motion is reduced in the proof; unused navigation, keyboard, sheet and Markdown integrations are fixture adapters. The status components, typography and step disclosure are not replaced.

Run `node apps/mobile/evidence/live-turn-status/proof.mjs --serve` to build both versions, verify live growth and capture the web/phone viewport images. After discovering and verifying an existing emulator through Beeline, reverse the local proof port (18495), open its local page in Chrome, and forward Chrome's existing debugging socket to (19495). Run `capture-android.mjs <granted serial>` for the Android images. Never start an emulator.

Intentional visual differences: the working sentence in the thread/header/list, removal of elapsed/received details from the working line, and completed rows entering the existing steps fold. No step-row or fold redesign.

## Validation

- Full root `npm run typecheck` passed after integrating main (`d81649a03`). Server typecheck also passed after the invocation fence was added.
- Server lifecycle, presence, invocation transport, terminal owner, thread-list and wording tests passed (49 tests).
- Helper runner and live-step tests passed (45 tests). The PlaceSession integration regression separately passed and proves activity is written while the prompt promise remains unresolved.
- Working-line, thread-header, thread-label and multiple-agent presentation tests passed (57 tests).
- API contracts passed (441 tests); network codecs passed (11 tests). Codecs were regenerated from the changed contracts.
- Architecture and UI component policy checks passed.
- The broader PlaceSession suite encountered unrelated host restrictions: read-only `/var/tmp`, Git wrappers refusing fixture-only branch pushes, and the launcher-path assertion seeing the wrapper rather than `/usr/bin/gh`. Focused helper tests used a temporary `/tmp` isolation path; that test-helper change was restored and is not part of the PR. No broader PlaceSession passing result is claimed.


CI repair validation: the previously failing server suites now pass locally (187 tests across queue, invocation, session lifecycle, thread attention, blocker reconciliation, review lifecycle and storage registry). Both failing mobile suites pass (9 tests). Server and mobile typechecks, the Walls check and its mutation tests (46), and dead-code detection pass. Finalization accepts registered invocations lacking a turn projection while retaining the replacement-session fence; regression coverage rejects obsolete final text and clears older sender projections. Idle fixtures explicitly finish their sessions, and the offline-start test compares newly added notices rather than earlier tests' history.
