# GitHub events as pills

Before/after captures of one Room stretch where agent messages and GitHub PR
events alternate (the stretch from the reported #beeline screenshot): 2 PRs
opened and 5 merged, an agent message, a lone "Opened #77", two agent
messages, 2 PRs opened and 3 merged, two agent messages.

- Before (`main` 5f45526): three styles in one stretch (chevron summary rows, a
  bold single event line, pills), split into five rows.
- After: one pill (GitHub ring, faces, "5 messages · 13 events"). Opened, it
  lists messages and events in send order; back-to-back events share one
  "GitHub ring · time" heading, read in body type with a brass #number and a
  brass chevron, and a group of more than three shows two and "N more".

Folded and opened, in Bone, Obsidian and Stone light, at phone width (390 px)
and desktop web width (1100 px).

The page was a temporary Expo web route (not committed) that renders the
production `TranscriptPills` and `NotificationLifecycleCard` over fixture
messages folded by `foldPrLifecycleRuns` and `foldPillRuns`. Faces come from
`IdentityMark` with the fixture seeds. The "before" captures used
`PillRow.tsx`, `TranscriptPills.tsx`, `transcript-pills.ts` and
`pr-lifecycle.ts` from `main`.

Files: `{before,after}-{folded,opened}-{phone,web}-{bone,obsidian,stone}.png`.
