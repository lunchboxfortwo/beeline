# Universal ACP Tool Outputs Proof (Before & After)

Before/after visual proof for universal ACP tool output capture, projection, and presentation on both Web (Playwright Chromium, `411×914 @2x`) and Native Android (`emulator-5554`, API 36, `1080×2400`, `420 dpi`) in Stone Light (Bone) and Stone Dark (Obsidian).

## Before (`origin/main` `a4359ad78`)

Rendered with `origin/main`'s production `TurnStepsLine` and `ToolOutputSheet` on the same fixture set reproducing the reported Android screenshots (`32349.jpg`, `32351.jpg`, `32358.jpg`):

- **Rows (`before-{android,web}-{bone,obsidian}-rows.png`)**:
  - Inline `python3` command and search rows collapse into cramped 40-char middle-truncation (`Ran python3 -c 'import j...r j in d["jobs"]]...`, `Found history · backlog items board work_i...`).
  - Unconditional `>` chevrons appear on path-only reads (`Read beeline-connecting-services/SKILL.md`, `Read ChatTree.tsx`), empty metadata reads (`Read message`), and single-line status failures (`Failed vitest run` / `command not found: vitest`).
  - Subagent origin, line ranges, diff stats, and `SIGKILL` stat are missing; failure reason picks `PASS src/room-turn-steps.test.ts (48 tests)` instead of the `SIGKILL` line and overlaps the row divider.
- **Sheets (`before-{android,web}-{bone,obsidian}-sheet-read-skill.png`, `before-{android,web}-{bone,obsidian}-sheet-empty.png`)**:
  - `Read beeline-connecting-services/SKILL.md` leaks raw `agent-home/codex/skills/beeline-connecting-services/SKILL.md` as a fake body with `Raw output` and `Copy raw`.
  - `Read message` opens a dead `No output saved` sheet.

## After (branch `feature/corner-c6af4d09e2d9`)

Rendered with this branch's production `TurnStepsLine` and `ToolOutputSheet` (standalone release APK on native Android, Metro web bundle on Playwright Chromium):

- **Rows (`{android,web}-{bone,obsidian}-rows.png`)**:
  - Two-line wrapped subjects with tail ellipsis and specific summaries replacing inline scripts (`Ran Inspect release run job statuses and failed legs for run 45925038255`).
  - Subagent origin scoping (`subagent · researcher` above `Found history · backlog items board work_items` with exact `4 hits`).
  - Chevron acceptance invariant: path-only reads (`Read beeline-connecting-services/SKILL.md`, `Read ChatTree.tsx:114–145`), empty metadata reads (`Read message`), and status-only failures whose full single-line reason is already visible (`Failed vitest run` / `command not found: vitest`) stay quiet and non-tappable with no chevron.
  - Simultaneous identical commands (`npm test --workspace=@beeline/body`) stay distinct: one observed exit 0 with output, one failed with red `SIGKILL` stat and distilled `Killed (signal SIGKILL — memory limit reached)` reason.
  - Same-file twin calls in one turn: quiet `Read ChatTree.tsx:114–145` (no chevron) beside `Edited ChatTree.tsx` with exact `+6 -3` stats and chevron.
- **Universal 2-zone sheets (`{android,web}-{bone,obsidian}-sheet-{mixed,sigkill,diff,exit0,edge,secret}.png`)**:
  - `mixed`: Full wrapping title, ordered caption + media receipt (`Image · image/png · 142 KB`, no fake open button) + structured JSON key-value card.
  - `sigkill`: Red `Signalled · SIGKILL` and amber `Bounded` pills, wrapped mono output, collapsible `Invocation` Zone 2 without duplicating output, honest `Copy excerpt`.
  - `diff`: Single-file path subtitle, `Completed` + `Bounded diff` pill, partial diff hunks, `Raw patch` Zone 2, honest `Copy excerpt`.
  - `exit0`: Observed `Exited (0) · no output` card with auto-expanded Zone 2 `Command` (zero duplicated Output), honest `Copy command`.
  - `edge`: `Sanitized` badge, strict grouped search matches (`apps/server/src/room-tool-projection.ts`), colon-bearing logs and Windows paths preserved as plain mono (never misparsed as matches), redacted resource link (`?token=[REDACTED]&page=2`, not fetched), and honest unknown block (`custom_widget`).
  - `secret`: `Output hidden: contains a secret.` notice with no copy or Zone 2 disclosure.
