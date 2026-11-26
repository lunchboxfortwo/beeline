# Activity ledger and tool sheets (full ACP + handoffs)

Before/after captures of the flat activity ledger (`TurnStepsLine` / `ActivityTimeline` / `LedgerDisclosure`) and result-first `ToolOutputSheet` in Bone (`light_brass`) and Obsidian (`dark_brass`) themes at phone (`390 px`) and web (`1100 px`) widths, alongside a rendered capture of the owner-approved v3 mock (`mock-v3-reference.png`).

## How these captures were taken

Captured in headless Chromium (`2×` device scale factor) bundling the production `TurnStepsLine`, `ActivityTimeline`, `LedgerDisclosure`, `ToolOutputSheet`, `tool-ledger`, `tool-call-row`, `tool-call-classify`, `activity-timeline`, `tool-identity-lookup`, and `tool-output-format` modules inside `TamaguiProvider` with the real Space Grotesk and IBM Plex Mono fonts (`HEAD` for `before-*`; branch working tree for `after-*`). Expanded ledger rows were opened by real click events on each `tool-run-group-*` disclosure trigger.

## Scenes covered

- **Ledger (`*-ledger-{bone,obsidian}-{phone,web}.png`)**:
  1. Closed and expanded 1-step handoff (`32269.jpg`): down/up chevron after count text, human `@crayon` and `#helper-index-flake` resolution, no raw 64-hex/UUIDs or repeated prose.
  2. Mixed ACP stream: inline interim `note` (no `›`), `ToolSearch` (`Loaded wake`), schedule lookup, and `Failed` row with two-line brass status/reason and no duplicate `✗`.
  3. Long run (`>5` steps): flat single-item list behind the left guide bar inside a bounded scrollable box (no nested observation folders).
- **Tool sheets (`*-sheets-{bone,obsidian}-{phone,web}.png`)**:
  1. Sent message card (`32269.jpg`): `Ruby → Crayon` + `Thread task` tag + sent message body above folded `Raw JSON ⌄` and `Copy raw`.
  2. Flat JSON receipt (`32261.jpg`): stripped markdown fence, intact `?tab=campaigns` URL and Python variable, key-value card above folded `Raw JSON ⌄`.
  3. Empty lookup banner (`32263.jpg`): `Searched Trusty Squire tools`, empty-result banner with query chips above folded raw payload.
  4. Bounded schedule array cards: stacked item cards with status badges, `Bounded` pill, and `+ 6 more schedules omitted at the 4 KiB step cap`.
  5. File edit unified diff: color-coded `added` / `removed` diff lines above folded raw footer.
- **Approved mock (`mock-v3-reference.png`)**: rendered capture of Carbon's approved `Activity Ledger & Tool Sheets (v3 — Full ACP + Handoffs)` HTML mock (`27c3eba0-ef32-4775-b014-5bb0e505daf2`).
