# Command approval choices

Reproduction COMMAND-APPROVAL-1: a pending command approval offered Approve / Once / Deny in the shared transcript card and Once / Always / No in the Needs You tray. The expected choices are Approve always and Deny. The historical human card was already answered; these captures use an isolated pending, hash-bound script fixture instead of making a production approval request.

The updated existing `GrantRequestCard.test.tsx` and projected-action tests in server `needs-you.test.ts` fail against the baseline choices and pass with the fix. Only command grants lose Once. Other grant kinds keep their existing controls, and server authority and script binding are unchanged.

## Captures

For each theme, compare `before-<theme>-web.png` with `after-<theme>-web.png`, and `before-<theme>-android-chrome.png` with `after-<theme>-android-chrome.png`. Bone and Obsidian were captured at desktop width and in Chrome on the already-running, explicitly granted Android emulator. `captures.json` records desktop and phone viewport button labels and the actual Deny callback value.

These are built production `GrantRequestCard`, `AgentApprovalCard`, `TranscriptCard`, grammar, Tamagui theme configuration, and fonts, bundled locally with esbuild. The fixture substitutes only non-target media, identity mark, ledger, pill, animation, safe-area and haptic adapters; it has no backend or production account. Browser clicks exercise the production card's decision callback. Before uses the baseline card source; after uses the changed source. The Android screenshots show the same shared web renderer on a phone, not an installed native binary. Native iOS and Android installed-app captures are unavailable: this isolated fixture has no native app build. No deployed behavior is claimed.

## Denial proof

The existing server integration refusal case is parameterized for a command with script contents/hash. It requests the grant through HTTP, reads the real Needs You operation, checks Approve always / Deny, denies through the phone operation, then verifies denied history and no live grants. A non-owner's decision remains refused by the existing projected-action regression.

After building the body workspace, run `node apps/mobile/evidence/command-approval/denied-runner.mjs`. This invokes the production built command runner against the resulting no-live-grant / denied-history state with an isolated script that would write a marker. It must refuse before execution and leave the marker absent; `denied-runner.json` records that result. The runner's API adapter supplies the service-tested state; this is a narrow execution-boundary stand-in, not a production daemon run.

Validation: card renderer suite, complete Needs You suite, complete grants-approvals-3 integration suite, root typecheck and mobile UI policy. Full device lifecycle, production grant creation, native app rebuild, and unrelated repository suites were not run because the change only changes command-card choices and reuses existing server decisions.
