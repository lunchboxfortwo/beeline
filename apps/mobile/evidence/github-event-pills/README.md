# GitHub events as pills

Before/after captures of one Room stretch where agent messages and GitHub PR
events alternate (the stretch from the reported #beeline screenshot, plus a
thread opening and a stop, as in mock revision 3): 2 PRs opened and 5 merged,
an agent message, "Opened #77", a thread opening, two agent messages, an
agent's stop, 2 PRs opened and 3 merged, two agent messages.

- Before (`main` 5f45526): three styles in one stretch (chevron summary rows, a
  bold single event line, pills), split into five rows.
- After: one pill (GitHub ring, Beeline ring, faces, "6 messages · 14
  events"). Opened, it lists messages and events in send order in the message
  column. Back-to-back GitHub events share one "GitHub ring · time" heading;
  the thread opening sits under a "Beeline ring · time" heading. Events and
  the stop read in one system-line format (meta at the quiet ink, brass
  #number, brass chevron); agent messages stay body type. A group of more
  than three shows two and "N more".

Folded and opened, in Bone, Obsidian and Stone light, at phone width (390 px)
and desktop web width (1100 px).

The page was a temporary Expo web route (not committed) that renders the
production `TranscriptPills` and `NotificationLifecycleCard` over fixture
messages folded by `foldPrLifecycleRuns` and `foldPillRuns`. Faces come from
`IdentityMark` with the fixture seeds. The "before" captures used
`PillRow.tsx`, `TranscriptPills.tsx`, `transcript-pills.ts`,
`pr-lifecycle.ts` and `Ledger-ledger-steer.tsx` from `main` (5f45526).

Files: `{before,after}-{folded,opened}-{phone,web}-{bone,obsidian,stone}.png`.
