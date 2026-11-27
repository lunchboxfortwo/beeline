# Universal ACP Tool Outputs Proof

Visual proof for the universal ACP tool output contract, capture, projection, and presentation pipeline on both Web (Playwright Chromium, 411x914 @2x) and Native Android (emulator API 36, 1080x2400, 420 dpi) in Stone Light (Bone) and Stone Dark (Obsidian).

## What the screenshots prove

- **Rows (`*-rows.png`)**:
  - 2-line wrapped step rows with tail ellipsis and specific summaries replacing inline shell/Python scripts (`Ran Inspect release run job statuses and failed legs for run 45925038255`).
  - Subagent origin scoping (`subagent · researcher` above `Found history · backlog items board work_items` with exact `4 hits`).
  - Chevron acceptance invariant: path-only reads (`Read beeline-connecting-services/SKILL.md`, `Read ChatTree.tsx:114–145`), empty metadata reads (`Read message`), and status-only failures whose single-line reason is already visible on the row (`Failed vitest run` / `command not found: vitest`) stay quiet and non-tappable with no chevron.
  - Simultaneous identical commands (`npm test --workspace=@beeline/body`) kept distinct: one observed exit 0 with output, one failed with red `SIGKILL` stat and distilled `Killed (signal SIGKILL — memory limit reached)` reason.
  - Same-file twin calls in one turn: quiet `Read ChatTree.tsx:114–145` (no chevron) beside `Edited ChatTree.tsx` with exact `+6 -3` stats and chevron.
- **Universal 2-zone sheets (`*-sheet-*.png`)**:
  - `mixed`: Full wrapping title, ordered caption + media receipt (`Image · image/png · 142 KB`, no fake open button) + structured JSON key-value card.
  - `sigkill`: Red `Signalled · SIGKILL` and amber `Bounded` pills, wrapped mono output, collapsible `Invocation` Zone 2 without duplicating output, honest `Copy excerpt`.
  - `diff`: Single-file path subtitle, `Completed` + `Bounded diff` pill, partial diff hunks, `Raw patch` Zone 2, honest `Copy excerpt`.
  - `exit0`: Observed `Exited (0) · no output` card with auto-expanded Zone 2 `Command` (zero duplicated Output), honest `Copy command`.
  - `edge`: `Sanitized` badge, strict grouped search matches (`apps/server/src/room-tool-projection.ts`), colon-bearing logs and Windows paths preserved as plain mono (never misparsed as matches), redacted resource link (`?token=[REDACTED]&page=2`, not fetched), and honest unknown block (`custom_widget`).
  - `secret`: `Output hidden: contains a secret.` notice with no copy or Zone 2 disclosure.
