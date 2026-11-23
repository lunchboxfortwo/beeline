# Corner state reference

`apps/server/src/corner-machine.ts` owns the state type and pure `transitionCorner`.
`apps/server/src/corner-lifecycle.ts` owns the `advanceCorner` runtime.
Close and confirmed merge execute command/workflow/hold cleanup in that runtime module.
Every corner command enters that runtime; the generic
queue retains membership, provenance, deduplication and turn authority.

The machine persists one state on `corner_facts.machine`. Every new corner starts
Idle; an opening order, if present, supplies its first event:

- **Working:** an implementing command or receipt is active.
- **Review:** checks are underway (`checks`), or the configured reviewer owns the
  current head (`reviewer`). The corner override wins over the parent Room reviewer.
- **Waiting:** an explicit blocker, user action or question needs an answer. These
  waits remain visible during CI. A running worker takes precedence; the wait
  returns when the turn ends if its blocker is still open. A merge hold vetoes
  landing while work continues; it becomes Waiting when it is all that remains.
- **Idle:** no implementing, review or waiting work remains.
- **Archived:** terminal after authorized closure or a confirmed merge. A locked
  standing corner remains active after a merge.

Red checks wake the implementer with the recorded failing jobs. Green checks wake
the independent configured reviewer inside the corner. Review uses the required
checks when configured and the whole rollup otherwise. Completed findings go
to the recorded implementer once per review. A completed request without a
verdict ends that request. A new green check result, head or brief revision can
request review again. A missing handback command is replanned using the same ID.
Reports retain their current order-author return route.

Pending approval grants also keep their recorded `room_id` corner in
Waiting, even when the approval card lives in the owner's private
System DM and cites a message from another Room. The machine reads only the
pending grant identity; the card and its resource details stay private. An
owner's decision resumes the requester through the existing grant-decision
delivery; that committed command event also moves the corner out of Waiting.

Committed changes to commands, receipts, GitHub facts, waits and holds enter the
same runtime. Server startup and listener resync replay recorded facts without
reading GitHub or starting a timer. State and effect receipts commit with their
commands. A proposed wake that queues no work does not by itself force an unchanged
machine write. Reads render the stored machine state, without deriving it from
turns or the GitHub display cache. Waiting has no separately stored reason;
read projections attach the current blocker's reason and identity. Existing hidden lifecycle
cards remain inert history during the expand release; no new cards are written.

Coverage: `corner-machine.test.ts`, `corner-lifecycle-event-replay.test.ts`, `corner-state.test.ts`,
`corner-state.exhaustive.test.ts`, `corner-state-reference.test.ts`,
`corner-review-dispatch.test.ts` and `corner-attention.integration.test.ts`.
`node --test packages/scripts/corner-machine-boundary.test.mjs` plants violations of the
state-write and wake boundary; TYPECHECK runs the same guard through architecture
checks. The boundary has one owner and no per-call exemption list.
