# TAGS-1: addressed decisions versus actual tags

Human intent: lunchboxfortwo, message e84d25a9ad03a78986ff59e20f0043be5e3651f0f6a0b9e38e1b53e2b6e0c13c.
Commander clarification: Ruby, order a015334af7642d6b995de123eac39f5d415a957e1cd005c7970a4c92413333cb, carried by brief revision 2.

## Reproduced

The root decision report 3f501cf3d4295ca7d3b8540e2f2e0eb7bdc9cec59fabb15a487d9ee9f9dce890 has no viewer tag and a card.reportToId addressing lunchboxfortwo. Ruby identified it as the original Tags card: the person opened its conversation and replied to the later d23f4254 message. The latter is excluded by both the actual tag and ask predicates, and has no Needs-you mark. It was not an inherited tag.

needs-you.ts deliberately admits addressed reports, but its original DTO gives the phone no way to distinguish them from tags. tag-card-model.ts labels every non-approval item tagged you. The extended existing report regression fails against the original projection because addressedReport is missing.

Second case: production message f053f799bbb5f506a74c728102df849ac138e61d1d719601a38fefd36d48b255 itself contains unquoted tags of lunchboxfortwo, bananaman614305 and niglet. Production generated SQL resolves all three. The stored MCP mention and agent_tag command cd5bd0d23c1992492cc38c912b96370d70e61fb50b28bce110b777364fc250dd correctly target niglet. agent-command-route-agent-result.ts resolves the source message's own text. No wake change or new passing-only wake test is warranted.

## Demonstrated

Build the server and run the isolated script from the repository root:

```sh
npm exec -- turbo run build --filter=@beeline/server... --concurrency=2
node --import tsx scripts/prove-tags-list.mjs
```

This starts the built server on a loopback ephemeral port, substitutes only authentication for an isolated viewer, and sends real phone WebSocket readNeedsYou/countNeedsYou requests through the normal operation dispatcher and generated response codec. A migrated PGlite database contains the own-agent reply chain plus a real viewer tag and channel ask. The result in items.json contains only root, real and channel. The production tag sentence formatter labels root Ruby needs your decision, and real/channel tagged you. Count matches the visible items.

The original production state has already been answered; no production writes were made to recreate it. This isolated built service is the closest repeatable stand-in.

The mobile render regression in tray.test.tsx mounts the production screen, card and section headers with the existing host/provider fixtures. It verifies a separate Decisions group, Ruby needs your decision, and Maya tagged you. The existing tray tests also cover reading, clearing, approvals and source navigation. Both tray suites pass (25 tests).

## Rendered screen stand-in

```sh
node proof/tags-1/build.mjs
node proof/tags-1/run.mjs
```

The browser bundle renders the production TrayScreen, TagCard, tag sentence model and RoomListSectionHeader with the socket proof's items.json. hosts.tsx replaces native/Tamagui hosts with browser elements using the shipped theme colors, spacing and font files; services.tsx supplies isolated app providers. This is a rendered component screen fixture, not an installed native binary or a signed-in production app. The older projection mode omits addressedReport, reproducing the original tagged-you label and Tags grouping with the same current components.

Playwright asserts the root label/group, real viewer/channel labels, and opening the exact root message. render-results.json records every case. screenshots contains before/after captures at phone (390) and desktop (960) widths in Bone and Obsidian. No mock was supplied. The only intended changes are the decision label and grouping authorized by the human bug report and commander clarification above. Existing cards and navigation remain in use.

Full root npm run typecheck passes, including mobile and scripts. The server Needs-you and merge suites pass (45 tests); UI component policy and the design detector pass.

Stored rows need no cleanup: the report is a legitimate addressed decision. The new optional addressedReport projection field distinguishes it on reread; eligibility, count, expiration and clears are unchanged. Older phones tolerate the additive field but need the updated mobile bundle to display the new distinction.
