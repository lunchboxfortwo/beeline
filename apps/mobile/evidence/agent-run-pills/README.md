# Agent run pills

Before/after captures of one chat that holds a 1→1 run, a 1→5 fan-out, a person
stop, two person stops in a row, four system notices in a row (a merge hold, a
join, a person stop and a call with no subject), and three opened pills: an
agent run with an agent stop, a lone system notice, and the four-notice stack.
The opened pills show that every pill opens into the same column. Bone and
Obsidian, at phone width (390 px) and desktop web width (1100 px).

The page was a temporary Expo web route (not committed) that renders the
production `TranscriptPills` component over fixture messages. Faces come from
`IdentityMark` with the fixture seeds. The "before" captures used
`PillRow.tsx`, `TranscriptPills.tsx` and `transcript-pills.ts` from `main`.

Files: `before-{phone,web}-{bone,obsidian}.png`, `after-{phone,web}-{bone,obsidian}.png`.
