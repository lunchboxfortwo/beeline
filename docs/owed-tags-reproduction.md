# Owed tags that survive answers

Reproduction owed-tags-1, observed on production on 10 November 2026.

Ruby's tool replies carried old tags after their conversations finished. Read-only
Neon SQL against `rooms_mcp_mentions`, `messages` and `agent_commands` confirmed
the source shapes; no production rows were changed.

The clearest example is message
`841917f5eabd7bfb481b2037ae1920d723c2aed4069bbf075938ee12fd69ee72`
in Room `392a8792-4395-400b-824f-f15b0db2c719` (the proof169 library prompt).
Ruby's ordinary visible answer has `request_id` equal to that source message
and NULL `reply_to_message_id`. Its ledger row remains uncleared. Other rows,
including `4caeca9899026893e2bc5a3fc459c6c0282f06544a62a406747f483f43b6a26f`,
have cancelled source commands but remained owed.

The previous fix, PR #4158 (`bb729b56d`), added only a read-time check for
`reply_to_message_id`. Its regression recreated a late ledger row after an
explicitly threaded answer. It missed the actual helper final-answer shape and
cancelled source conversations. The MCP catch-up page also lacked that check.

The apparent other-agent tags in the brief require care: `replyRule` names the
**author to address in the answer**, not the recipient. For example,
`84b2b048095d2892b3fd6af6fc7da7b3b5d4cfa9f2a0daf20c03a466f62a9870`
starts with `@firstmate_2` but also contains `@ruby` later. Likewise the Claude
message starting `@lunchboxfortwo` contains `@ruby` at the end. These are real
Ruby tags, not evidence that its member filter leaks other agents' obligations.
Regression coverage separately verifies that a tag recorded only for another
agent never appears for the caller. The durable member/message ledger continues
to preserve addressing through handle renames.

Applying the candidate predicate read-only to the same production snapshot
reduced active-Room candidates from (40) to (4), dropping (36) answered or
cancelled conversations. The retained set includes failed activations without
answers: an old age or a completed command alone must not discard an unanswered
human tag. This comparison evaluates the candidate SQL; it does not claim the
candidate was deployed or that Ruby's live tool response has changed.

## Reproduced

The regression in `apps/server/src/owed-tag-replies.test.ts` recreates proof169's
source ID and missing reply link, plus a cancelled source, another agent's tag,
an open human tag, an activity-only turn and an answer from a renewed request ID.
On the unmodified implementation it fails because proof169 remains owed.

## Demonstrated

Build the server, then run:

```sh
npm run build --workspace=@beeline/server
node --import tsx packages/scripts/prove-owed-tags.mjs
```

This isolated service proof reads the built server's authenticated
`GET /v1/daemon/owed-mentions` endpoint. It starts with open obligations, inserts
the historical request-linked answer, closes a source through
`beeline_end_agent_turn`, and reads again. Only the still-open human tag remains.
It posts an explicit answer through `PhoneService.sendRoomReply` and confirms
the list is empty, then confirms Room archival removes a fresh open tag.
Another agent's tag never appears. The same identifier is used in the regression
and the proof output.

The candidate is not deployed during corner work, so an actual Ruby tool call
cannot demonstrate the new server behavior yet. The closest stand-in is the
built authenticated service using production source shapes, backed by the
read-only comparison against the actual production rows.

Validation passed: the built HTTP proof above, both `owed-tag-replies.test.ts`
and `rooms-mcp.test.ts` (78 tests), the server TypeScript build, referenced-path
checks and `git diff --check`. The MCP HTTP suite needs IPv4-first DNS on this
host because its listener binds IPv4 while short join aliases use `localhost`:

```sh
NODE_OPTIONS=--dns-result-order=ipv4first npm test --workspace=@beeline/server -- --maxWorkers=1 --minWorkers=1 src/owed-tag-replies.test.ts src/rooms-mcp.test.ts
```

No tests in those suites were skipped. The full repository suite was not run;
this change is confined to the server's owed-tag read predicates.
