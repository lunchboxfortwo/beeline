# UAR-1: reports addressed to a person

Human approval: lunchboxfortwo's message
`70cb4fd4b2e7cc6c9c0468679386416e7af870d970112bdbf7b66838e6824c78`,
carried by corner brief revision 1.

The mobile chat renderer test in `TranscriptPills.test.tsx` renders the actual
`useChatTranscriptRenderer` with host/card boundaries replaced. A person report
and a legacy report show the whole command text immediately, even when mentioning
an agent; an agent recipient remains collapsed. The inspector render regression
also checks that its ordinary message receives the command body, rather than the
short server summary. Both regressions fail against their original owner code.
The folding regression verifies that readable reports split pill runs while
retaining each run's read boundaries.

## Built browser stand-in

Run from the repository root after preparing mobile dependencies:

```sh
node proof/agent-command-recipient/build.mjs
node proof/agent-command-recipient/run.mjs
```

The bundle uses production `TranscriptLine`, `PillRow`, `IdentityMark`, recipient
classification, folding, and the shared command formatter. `hosts.tsx` replaces
native/Tamagui hosts and app providers; it is a component fixture, not a signed-in
full app or an installed native build. Phone screenshots are browser phone-width
captures. No mock was supplied; no full-message visual redesign was made.
The before mode applies the original command-is-always-a-pill decision.
Playwright checks actual rendered text visibility before capturing each image.
`results.json` records before/after results in Bone and Obsidian at phone and web
widths. Person/legacy bodies are hidden before and visible after; the agent body
is hidden in both.

An existing emulator was reachable via the granted ADB host, but the required
second grant for its device address was refused because the command was already
complete. No emulator was started or modified. The render regressions and built
browser component fixture are the closest available UAR-1 stand-in; native binary
proof and a signed-in production report were not exercised.
