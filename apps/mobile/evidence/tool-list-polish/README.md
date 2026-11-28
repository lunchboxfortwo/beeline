# Tool List Polish Visual Proof (Before & After)

Before/after screenshots rendered from production `TurnStepsLine` and `ToolOutputSheet` via Expo Web + Playwright Chromium (`2x` scale) across Bone (light) and Obsidian (dark) themes at phone (`390px`) and web (`1100px`) widths.

## Before (`origin/main` `91feab42c`)

- **Rows (`before-{bone,obsidian}-{phone-390,web-1100}-rows.png`)**:
  - Collapsed summaries emit raw step counts (`5 steps`, `2 steps`, `3 steps · 1 failed`) with amber `needsYou` emphasis on failures.
  - Expanded rows sit behind an indented `1.5px` left guide rail, label search steps as `Found`, show unaligned variable-width verbs, expand consecutive file reads as separate rows, and color diff stats (`+2 -1`), chevrons, and `Failed` with green/red/amber accents.
- **Prose sheet (`before-{bone,obsidian}-{phone-390,web-1100}-sheet-prose.png`)**:
  - Web search output renders as a raw monospace wall with inline `Sources:` markdown URLs.
- **Diff sheet (`before-{bone,obsidian}-{phone-390,web-1100}-sheet-diff.png`)**:
  - `Bounded diff` badge and `M` file status use amber `needsYou` styling.

## After (`feature/corner-03ac50a9cb1e`)

- **Rows (`after-{bone,obsidian}-{phone-390,web-1100}-rows.png`)**:
  - Outcome-only collapsed summaries (`Edited ChevronGlyph.tsx · ran tests`, `Searched web`, `Ran tests · 1 failed`) with monochrome bold `ink` emphasis on failures and zero step/read/query counts.
  - Flush-left rows aligned with the message text edge (no left guide bar), separated by `1px` hairlines, with a fixed-width Space Grotesk verb column (`Searched`, `Checked`, `Edited`, `Ran`, `Failed`), consecutive reads folded into `Checked 3 files · ThreadHeader.tsx, ChevronGlyph.tsx +1`, and monochrome tokens across verbs, diff stats (`+2 -1`), exit codes (`exit 1`), and chevrons.
- **Prose sheet (`after-{bone,obsidian}-{phone-390,web-1100}-sheet-prose.png`)**:
  - Clean `web search` subtitle, readable body prose card, separated monospace citation links (`docs.anthropic.com/en/docs/claude-code`, `opencode.ai/docs/tui`), and collapsible `Arguments & raw` footer.
- **Diff sheet (`after-{bone,obsidian}-{phone-390,web-1100}-sheet-diff.png`)**:
  - Monochrome Stone `Bounded diff` badge and `M` file status header, with green (`added`) and red (`removed`) coloring exclusively on diff lines.
