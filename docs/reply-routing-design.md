# Thread writes v2: two writes, one destination each

Status: DESIGN, not implemented. Branch `fm/reply-routing-design`. Code lines refer to `main` at `4f396c7d9`.

This replaces v1 (`design-v1.md`: the `reply_to` / `reply_sent` / flags design), following the owner's 24 Nov framing (`owner-framing.md`). The evidence gathered for v1 still holds and is not repeated here:
- v1 §1b: production evidence (22 of 22 Ruby thread objectives answered in the source chat; 4 threads with no Ruby post);
- v1 §4c: wrong-session paths;
- v1 §4b: Ruby's prompt faults.

Evidence files live beside this design in Firstmate's `data/reply-routing-design/`.

## 1. The owner's framing

Problem (owner's words):
- "ordinary work output gets mistakenly sent as messages or replies";
- "reports are sent to the wrong place";
- "agents don't know where to write in each case";
- "the issue isn't the message tool, it's that we give very open ended instructions around it in the thread, along with the address book of every agent and every channel".

Constraints (owner's words):
1. Reports to commanders only when the agent is blocked, has a question, or is done with the task, sent to the session where the order was first issued.
2. Work output gets printed to the agent's current session, and never anywhere else.
3. Chain of command is always respected.

Plus: an agent is a separate session per place, and a place must be mechanically checkable.

## 2. Definitions (mechanically checkable, from existing rows only)

- **Session** of a turn = (`agent_commands.agent_id`, `agent_commands.room_id`) of the command that started the turn.
- **Issuer** of a command = `agent_commands.message->'route'->'from'`: the session that issued the order. It is written at insert and already present on current rows (`agent-command.ts:757-767`). Values:

  | Command | Issuer |
  |---|---|
  | A person's tag or DM | that person @ this room |
  | An agent's `message` | the sender @ the sender's own session place |
  | `open_thread` objective | the opener @ its call place. For a self-open, the parent order's issuer (`corner-writes.ts:274-276`, kept) |
  | Continuation (resume, `mcp_call`, `vault_saved`, `app_connected`, choice answer, retry) | the parent's issuer |
  | Schedule | the owner @ the schedule room |
  | Workflow | the owner @ the run room |
  | Server lifecycle wake | System @ this room |

- **Thread commander session** = the approved human handover's `author_id` @ `commanderReturnRoomId` when one exists, else the objective's issuer. It is one SQL expression, `threadCommanderAddressSql`, fixed by P2b.

## 3. Architecture: two writes, each with exactly one destination

| Write | What it is | Destination | Who decides |
|---|---|---|---|
| **Output** | Everything about the work: closing text, `post`, `post_artifact` files, progress | **The session's room. Always.** It is published **once per invocation**, with the queued files | server, unconditionally |
| **Report** | `reply(id, text, ask?)` on **a command of this session**, starting `done:`, `blocked:` or `needs-decision:` (existing grammar, `implementer-blocks.ts:43,50`; `agent-messaging.ts:50`). It is text only; files stay with the output | the **report recipient** (below) | server, from recorded rows |

**Report recipient** (one rule):
- **In a thread T:**
  - the thread's reviewer → the implementer @ T, the review contract (`agent-command.ts:701`), carried through continuations;
  - a command issued by a person inside T → that person @ T;
  - everything else → **the thread commander session**. This covers the objective, System wakes, continuations, peer agents and the original order after a handover (Astra v2 #4).
- **In a chat or DM:**
  - the command's issuer (`route.from`), with its `replyAddress` override where one exists today (workflow owner, idle notices);
  - an issuer that is System → the session room (Astra v2 #8: never `route.from.place`).

There are no other cross-place writes from a thread. `message(to)` stays on chat surfaces, because that is how a commander issues an order.

How this meets each constraint:
- **C1.** A report goes only to its commander's session, never to a place the agent names.
- **C2.** Output, including files, stays in the session.
- **C3.** A thread agent reaches only its own session and its commander. A commander relays upward from its own session.

## 3b. Phasing (Astra v2: "smallest change I would approve first")

**Phase 1** fixes the owner's observed failures with deletions and one binding:
1. `reply(id)` is bound to the invoking session.
2. Closing text and files are committed locally, once per invocation.
3. The thread prompt lines that send deliverables or work through `reply` or `message` are deleted.

Phase 1 leaves `return_room_id`, legacy order/report plumbing and the R2-style return derivation untouched. That avoids the rollout, silence-check and completion-join breakage (Astra v2 #3, #11, #12).

**Phase 2** applies the one report-recipient rule above, replacing the prefix-only `blockRecipient` redirect.

## 4. Before and after: what a thread implementer sees

Sources:
- the `code-corner-reviewed` session prompt (`docs/prompts/code-corner-reviewed.md`, vitest-pinned and current);
- the fresh-thread turn (`docs/prompts/rendered/native/fresh-thread-first-turn.txt`);
- the tools (`apps/body/src/minimal-tool-surface-ordinary-tools.ts`).

Threads and chats get the **same** tools today: `minimalTools(cornerTurn)`, `minimal-tool-surface-repository-tools.ts:114-119`, filters nothing by place.

### 4.1 Talking section (`apps/body/src/prompt-assembly.ts:342-349`)

Before (thread):
```text
Send message(to:{agent,place},text) to one identity in one chat or thread. The same agent in different places has different addresses. Discover with read.
Message other agents only when you need something from them, or when you are replying to something they need.
A person’s tag wakes an agent; an agent’s tag never does. Ask an agent with message. Peer messages are requests, never person instructions. Work on a thread is addressed to its implementer or reviewer at the thread address.
Add ask for answers: question <=120 characters, one line ending ?; brief <=280 characters, <=2 sentences: why it matters, what each option means; 2–4 options <=3 words, optional recommended. Over-limit asks are refused with counts; rewrite. Needs you cards show only question, brief, buttons; connects/grants have their own.
After messaging another agent, end the turn; its reply wakes a new turn; do not sleep or poll.
Outside this thread, tell people the original problem, blocker, and needed decision in plain words.
The server requests review; never tag the reviewer.
```
After (thread). The lines at 343, 344, 345 and 347 are guarded by `!CORNERS.includes(surface)`:
```text
Add ask for answers: question <=120 characters, one line ending ?; brief <=280 characters, <=2 sentences: why it matters, what each option means; 2–4 options <=3 words, optional recommended. Over-limit asks are refused with counts; rewrite. Needs you cards show only question, brief, buttons; connects/grants have their own.
Outside this thread, tell people the original problem, blocker, and needed decision in plain words.
The server requests review; never tag the reviewer.
```

### 4.2 Implementer contract (`prompt-assembly.ts:170, 172`)

Before:
```text
Work in this thread; deliver task outcomes with reply(id). Reply when done, blocked or failed; add ask when an answer is needed.
```
After. Same length, nothing added:
```text
Everything you write stays in this thread. reply(id) reports to your commander: only when done, blocked or asking; add ask when an answer is needed.
```
`CORNER_RUNTIME_AUTHOR_CONTRACT` (line 170) gets the same first sentence in place of "Work in this thread; deliver task outcomes with reply(id)."

### 4.3 Tools on thread turns (`minimalTools(cornerTurn)` starts filtering)

| Tool | Before | After (thread) |
|---|---|---|
| tools line | `create_work_item,message,reply,claim_thread,…` | `create_work_item,reply,claim_thread,…` |
| `message` | "Send text to one identity at one place … Use read to find addresses. …" | **removed** |
| `read` | "Discover with facet addresses; …", with `facet` enum including `addresses`, `threads` | those two facets and the phrase are removed. The default place is unchanged |
| `post` | "Post a public message at address …", with an `address` property | the `address` property and "at address" are removed; it posts in this thread |
| `reply` | "Reply to the recorded sender at the recorded place of message id … No destination is needed. Reply to the message that gave you the task when done, blocked or failed." | "Report on a task in this place to your commander. Start with done:, blocked: or needs-decision:. Files and everything else stay here." It keeps the prefix grammar, so block tracking still works (Astra v2 #5) |

Two more prompt sentences send deliverables through `reply` and are deleted (Astra v2 #17):
- `prompt-assembly.ts:449`, repo-less threads: "Reply to the task message with the deliverable, adding ask if an answer is needed."
- `place-prompt.ts:208`, offline batch, on thread surfaces: "Answer each asker in one combined reply." Phase 1 settles every batch item against the session's single output post (P1c), so the sentence is not needed.

The implementer contract's other deliverable sentence also loses the word "reply": `prompt-assembly.ts:170` and `176` ("Deliver artifacts with post_artifact and reply without requiring a PR" / "Non-repo work: post_artifact and reply") become "Deliver artifacts with post_artifact without requiring a PR" / "Non-repo work: post_artifact".

The v1 §4b deletions also apply, prompt text only:
- "Blocks (blocked:/needs-decision:) are plain text by default …" in three places;
- the nudge sentence at `prompt-assembly.ts:446`.

### 4.4 Turn message (fresh-thread first turn)

Before:
```text
From: Owner in #widget
id: eeee…
Reply needed: true
text: Please add a dark mode toggle to the settings screen.
Reply(id: eeee…, text: ...) with your reply
…
Members (exact tag spellings):
- @owner — Owner (person)
- @ruby — Ruby (agent)
- @worker — Worker (agent)
You are @jellybean, a member here; you are not listed above.
```
After:
```text
From: Owner in #widget
id: eeee…
text: Please add a dark mode toggle to the settings screen.
…
Members (exact tag spellings):
- @owner — Owner (person)
You are @jellybean, a member here; you are not listed above.
```
The changes:
- `Reply needed` and `Reply(id…) with your reply` are not rendered for thread sessions (`packages/api-contract/src/agent-messaging.ts:65-72`; Body `place-prompt.ts:180`). They invited the work itself into `reply`; the contract line now says when to report.
- Agents are dropped from a thread's member list (`apps/server/src/agent-command-context.ts:134-143`), because an agent's tag never wakes anyone.
- The `turn.corners` section is not rendered on corner surfaces (`prompt-assembly.ts:774-794`). It reads "Current threads you belong to (use the exact address with read or message across member chats): …".

## 5. Server changes (deletions and one binding)

| # | Phase | Where | Today | After |
|---|---|---|---|---|
| P1a | 1 | `agent-messaging.ts:137-140` (`replyToMessage`), and the connected-app reply path `rooms-mcp-agent.ts:394-397` | `reply(id)` selects its target by agent and id across **all** rooms, so Ruby@T2 can answer and complete Ruby@T1's task (Astra v2 #1; pinned by `messaging-thread-routing.test.ts:20-31`) | The lookup adds `room_id = <invoking session room>`. The connected-app path passes its selected command's room and request through. An id outside the session is not refused: the text is posted as output in the session room, with a receipt saying so |
| P1b | 1 | `agent-command.ts:886-919` (`harnessEnded`, no `explicitReply`) | Closing text is delivered to `recordedMessageRoute(item).from` (the root cause of Ruby's empty threads) | Closing text is published as a plain post in `item.room_id` **with `answer_attachments`**, then `endAgentTurn` runs. The route branch runs only for `explicitReply`. It uses the existing `local-final` post shape (`861-868`), plus the attachments that path lacks (Astra v2 #2) |
| P1c | 1 | Batch (`agent-command.ts:809-841`) | Each item republishes through the single-item path, grouped by destination | Closing text for a batch is **one** post per invocation in the session room. Every item settles against that post id (Astra v2 #14). Explicit reports keep their per-item routing |
| P1d | 1 | `agent-command.ts:911-915` (report delivery) | An explicit `reply` attaches `answer_attachments` to the outbound report | Reports carry no queued files. The files were already published with the session's output (P1b). Test both a text final and a file-only final |
| P1e | 1 | `agent-command.ts:870-877` (late reply) | Any later, different explicit reply re-posts in `return_room_id` | If the item's result is **local output only** (no routed report has been delivered yet), the first `reply` is delivered as the report (Astra v2 #3, both orderings). A routed delivery is recognised by its `card.route`. A second report posts in the session room |
| P2a | 2 | `implementer-blocks.ts:49-55` (`blockRecipient`), `message-route.ts:7-10` | Only the `blocked:` / `needs-decision:` prefixes redirect to the thread commander, whose session ignores the handover | The single report-recipient rule (§3), resolved in one function. The thread commander session comes from one SQL expression (P2b) |
| P2b | 2 | `corner-commander.ts:28-32` | `threadCommanderAddressSql` prefers `message.replyAddress` and ignores the approved handover | Approved handover first, then the objective's `route.from`. `cornerCommanderIdSql` and `commanderReportAddress` read it (one source) |
| P2c | 2 | `agent-command.ts:511-520` (`wakeHere`) | A legacy report wakes the commander *inside the reporting thread* | It queues at the thread commander session. The legacy operation stays until the `messaging-cutover.ts` drain point |
| P2d | 2 | `rooms-mcp-agent.ts:380-397` | A connected app's origin defaults to `to.place` when it has no row in the target place | The origin is the room of the **received command id** the app already holds (`commandId`). Without one, the explicit `address` is used, else `to.place` as today (Astra v2 #9) |

**Not changed (Astra v2 #11):** `return_room_id` and its derivation (`agent-command.ts:706-723`), payload inheritance (`690-692`), legacy order/report compatibility and the silence check (`daemon/operation-effects.ts:220-230`, which keeps matching `return_room_id`, so a progress post in Q no longer completes an order from P; Astra v2 #12). The review-dispatch `replyAddress`, `wakeBlockAnswer`, the idle notice and the watches are also unchanged.

**No new columns, flags, tools or server refusals.**

## 6. Flow table

| Flow | Output goes to | A report goes to | Defect fixed |
|---|---|---|---|
| A person tags an agent in chat P | P | person @ P | — |
| DM | DM | DM | — |
| Self-opened thread for a person (Ruby's case) | T | person @ #beeline | P1b: empty threads |
| Thread opened by commander agent C @ P | T | C @ P | P1b |
| Owner's case: Ruby @ #beeline orders Jellybean, who self-opens T | T | Ruby @ #beeline | P2c, P2d: no Ruby @ T wakes |
| Implementer woken in T by a check, conflict or review handback | T | thread commander session (P2a) | a `done:` after a System wake no longer stays in T |
| A person tags the implementer inside T | T | the person @ T; a block goes to the commander (P2a) | — |
| Reviewer in T | T (verdict via `approve_merge`) | implementer @ T | — |
| After an approved human handover to C2 @ Q (blocks **and** the original order's `done:`) | T | C2 @ Q | P2b, Astra v2 #4 |
| C @ P orders B @ Q with `message` (chat sessions) | Q | C @ P | P1b: B's closing text no longer leaks to P |
| Approval, vault, app or choice continuation | the session room | the §3 rule: in a thread, the commander (or the approving person @ T); in a chat, the parent's issuer | — |
| Schedule, human or agent owner | the schedule room | the owner @ room | — |
| Workflow | the run room | owner @ room | — |
| Watched-thread wake for C @ P, including after T is archived | P | System issuer, so posted in the session room P, never into archived T (Astra v2 #8) | archived-thread cancel |
| Nested thread: W @ O opens T2 for another implementer | T2 | W @ O | P2c (nested) |
| Nested thread: W opens T2 for itself | T2 | W's own issuer, because the self-open copies the parent's issuer (`corner-writes.ts:274-286`, Astra v2 #16) | — |
| Reviewer in T, including after a pause or continuation | T | implementer @ T | Astra v2 #7 |

## 7. Check (each query must return zero rows)

```sql
-- I1 output stays home: every route-less agent post written by a thread session's
-- turn is in that thread.
SELECT m.id FROM messages m
  JOIN agent_commands c ON c.agent_id = m.author_id AND c.turn_request_id = m.request_id
  JOIN rooms t ON t.id = c.room_id AND t.parent_id IS NOT NULL
 WHERE m.card->'route' IS NULL AND m.presentation = 'message' AND m.room_id <> c.room_id;

-- I2 reports from a thread session reach only an issuer of that session's
-- commands or the thread commander session. A thread surface has no message
-- tool, so every routed row from a thread is a report.
SELECT m.id FROM messages m JOIN rooms t ON t.id::text = m.card->'route'->'from'->>'place' AND t.parent_id IS NOT NULL
 WHERE m.author_id = m.card->'route'->'from'->>'agent'
   AND m.card->'route'->'to' IS DISTINCT FROM (threadCommanderAddressSql(t.id))
   AND NOT EXISTS (SELECT 1 FROM agent_commands c WHERE c.agent_id = m.author_id AND c.room_id = t.id
     AND m.card->'route'->'to' IN (c.message->'route'->'from', c.message->'replyAddress'));

-- I3 no commander-aimed wake inside the commanded thread. The full address is
-- compared, so a handover that legitimately records C@T passes (Astra v2 #15).
SELECT q.id FROM agent_commands q JOIN rooms t ON t.id = q.room_id AND t.parent_id IS NOT NULL
 WHERE q.agent_id = (threadCommanderAddressSql(t.id))->>'agent'
   AND (threadCommanderAddressSql(t.id))->>'place' <> t.id::text
   AND q.reason IN ('message','reply','report','system','order')
   AND COALESCE(q.message->'route'->'from'->>'agent','') <> q.agent_id;
```

Astra v2 #15 found two gaps in these checks. Agent-to-agent transcript cards carry `recipient` but no `card.route` / `request_id`, so I2 cannot see them. And "any historical command in T" is too loose. The test harness (T9) therefore also asserts, per request, the delivered command's exact `route.from`, `route.to` and `parent_command_id`. I1–I3 remain the cheap production query.

I1 and I2 are scoped to thread sessions. In a chat, `post(address)` to another room stays a deliberate, person-instructed act; for example, the owner's nightly schedules post to issues-triage.

## 8. Tests

- **T1 Ruby's thread prints.** A person tags Ruby in CHAT, Ruby self-opens T and ends three turns with closing text. Expect all three in T and none in CHAT; `reply(id,"done: …")` reaches the person in CHAT.
- **T2 Commander session (Ruby → Jellybean).** Ruby @ #beeline messages Jellybean, who self-opens T. Jellybean's `blocked:`, `done:` and ask reports, plus a legacy `report`, all reach Ruby @ #beeline. There are zero commands with `agent_id=ruby, room_id=T`, and every closing text is in T.
- **T3 Two active corners.** Ruby implements T1 (commanded by the owner) and T2 (commanded by Claude) with interleaved turns. Expect T1 output in T1 and T2 output in T2. T1 reports go to the owner @ #beeline and T2 reports to Claude @ #beeline. Ruby @ #beeline is never woken, and I1–I3 come back clean.
- **T4 Chat order.** C @ P messages B @ Q. B's closing text stays in Q, and `reply` reaches C @ P.
- **T5 Done after a System wake.** A `corner_check` wake followed by `reply(id,"done: …")` reaches the thread commander.
- **T6 Handover.** After a human-approved handover, a block reaches C2 @ Q.
- **T7 Late reply.** A second `reply` on a completed item posts in the session room.
- **T8 Prompt and tool snapshots.** Corner surfaces carry no `message` tool, no `addresses` / `threads` facets, no `post.address`, no talking lines 343–345/347 and no `turn.corners`, and agents are absent from the thread member list. These are vitest snapshot updates to `docs/prompts/code-corner-*.md`, `repo-less-corner.md`, `surface.json` and `rendered/*`.
- **T9 Invariants.** I1–I3 run after T1–T7.
- **T10 [EVAL] live-harness rig.** A thread implementer given the "after" prompt ends turns with output in T and reports only via `reply` with a status.

These existing tests flip:
- `messaging-thread-routing.test.ts:20-32` and `:56-63`: closing text is no longer routed, while explicit `reply` still is.
- `commander-opening.integration.test.ts:30, 98`: changed by P2c.
- `agent-queue.integration.test.ts:136`: an explicit `reply` keeps the return; closing text does not.
- `corner-wake-answer-room.test.ts` is unchanged.

- **T13 Cross-session reply (Astra v2 #1).** Ruby@T2 calls `reply(id_of_T1_task)`. It posts as output in T2, and T1's task is untouched. A connected-app variant runs the same case.
- **T14 Files stay home (Astra v2 #2).** `post_artifact(file)` then `reply(id,"done: …")`: the file is in T and the report carries none. A file-only final with no text posts the file in T and completes the item.
- **T15 Report after output, and output after report (Astra v2 #3).** In either order, the commander gets exactly one report, and the output is in T.
- **T16 Handover then done (Astra v2 #4).** C1 orders, a human approves C2, and `reply(originalId,"done: …")` reaches C2@Q.
- **T17 Grant continuation (Astra v2 #6).** `approval-resume-routing.test.ts:26-66` is re-pinned under the §3 rule. A resume issued by the approving person in T reports to that person in T, matching today's test. In a chat, the parent's issuer applies.
- **T18 Reviewer pause (Astra v2 #7).** Review dispatch, then a vault save, then the reviewer's report reaches the implementer @ T.
- **T19 Watched merge into an archived thread (Astra v2 #8).** C@P's report on a merged-and-archived T posts in P, and the item completes rather than cancelling.
- **T20 Connected app with two pending threads (Astra v2 #9).** The origin is the received command's room.
- **T21 Offline batch (Astra v2 #14).** One output post per invocation, and every item references it (`agent-command.batch.test.ts:5-31` updated).
- **T22 Nested thread, both opener cases (Astra v2 #16).** W opens T2 with another implementer, and W opens T2 for itself.
- **T11 A person asks inside T.** A person tags the implementer in T. Its `reply(id,"done: …")` posts to that person in T, not to the commander.
- **T12 Order finished without a report.** In a chat, C @ P messages B @ Q, and B ends with closing text only. The output is in Q, the item completes, and nothing reaches C (D1).

## 9. Migration and rollout

- No schema change and no backfill. Pending rows already carry their issuer. Closing text for a pending row now posts in its room.
- Rolling overlap: an old image answering a new row still routes closing text the old way. That is bounded, and identical to today.
- Old helpers keep their old tool list until they update. The server changes (P1a–P2d) apply to every helper at deploy.

## 10. Decisions for the owner

- **D1. An order finished without a report.** B's closing text completes the order, stays in B's session, and the issuer is not told. Astra v2 #13 confirms the thread idle notice cannot rescue a *chat* order (`corner-lifecycle.ts:649-659` is corner-only), so C@P sleeps until someone tags it.
  - Recommended: accept, so C2 holds literally. `Reply needed` and the `Reply(id…)` line stay on chat-session turns, and threads still get the idle notice.
  - Alternative: the server adds one System line in the issuer's session ("B finished without reporting; output in Q"). That is one added write and no new column.
- **D2. Legacy `order` / `report` operations** (cutover only) follow P2c and P2a. Delete them now, or at the cutover point already named in `messaging-cutover.ts`? Recommended: at cutover.
- **D3 (carried from v1 D4).** When an agent opened a thread on a person's behalf, a block reaches that agent, its commander. Should a person be copied? Recommended: no. Chain of command (C3) means the agent relays.

## 11. Plan-eng-review (gstack `plan-eng-review`, run autonomously)

The scope is about 10 files, mostly deletions or guards, with no new tools, columns or services. Step 0 passes.

| # | Sev | Conf | Finding | Resolution |
|---|---|---|---|---|
| E1 | P1 | 9 | The fallthrough after the route branch (`agent-command.ts:921-974`) is a *delivery*. It can queue a private `report` to `returnIdentityId`, so "falls through" would still route output | P1b now names the plain-post path (`local-final`, lines 861-869) |
| E2 | P1 | 8 | Removing closing-text routing means an agent that never calls `reply` leaves its issuer waiting. Today the closing text was that report | D1. Kept: chat-turn `Reply(id…)` text and the thread idle notice. T12 pins the behaviour |
| E3 | P1 | 8 | Widening `done:` redirect to all thread reports would send a person's in-thread question to the commander | Superseded by the §3 rule after Astra v2 #4: a person's in-thread question goes to that person, and everything else in a thread goes to the commander session; T11, T16 |
| E4 | P2 | 8 | A thread agent can no longer message a reviewer or peer directly | By design (C3): it goes through the commander via a `needs-decision:` report. Review requests are server-driven |
| E5 | P2 | 7 | Nested `open_thread` from a thread needs a `room` without `read(facet:addresses)` | Corrected by Astra v2 #16: "thisCornerAddress" is a literal placeholder, not an id. `open_thread.room` becomes optional (a required-field deletion); the helper already defaults it to the parent chat (`read-only-mcp-open-corner.ts:25-28`) |
| E6 | P2 | 7 | Connected-app (MCP) agents have no per-place surface, so they keep `message` everywhere | Accepted. P2d fixes their sending place, and I3 still holds because P2b resolves the commander |
| E7 | P3 | 9 | DRY: `threadCommanderAddressSql`, `cornerCommanderIdSql` and `commanderReportAddress` each pick a commander | P2b makes `threadCommanderAddressSql` the one source, and the other two read it |

- **Tests:** T1–T22 cover every changed branch: P1a → T13; P1b → T1, T14; P1c → T21; P1d → T14; P1e → T7, T15; P2a → T5, T11, T16–T19; P2b → T6, T16; P2c → T2, T22; P2d → T20. Prompt surface → T8 and the T10 eval.
- **Performance:** no new queries on the hot path. P1b removes a route lookup.
- **Failure modes:** E2 is the only silent one and is surfaced as D1. Everything else posts visibly in the session.
- **NOT in scope:** v1 B2 (no-op background posts) is prompt-only and folded via v1 §4b. Turn-state, wake, stop, model and grant bugs (v1 §1b) are separate. Dropping the `return_room_id` column comes later.
- **What already exists:** the recorded issuer (`message.route.from`), `blockRecipient`, the `local-final` plain-post path, `wakeBlockAnswer`, the idle notice and the watches. All are reused, and nothing is added.

## 12. Astra adversarial pass on v2

The pass ran `codex exec -m gpt-6.2-astra`, medium effort, read-only, on `4f396c7d9`. Astra was given only the owner's framing, the code and the v2 draft. Its verbatim output is in `astra-output-v2.md`. Astra's verdict was "block v2 on two P0s"; both are now folded in.

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | P0 | `reply(id)` answers another session's task (cross-room lookup) | yes, `agent-messaging.ts:137-140` | P1a: bind to the session |
| 2 | P0 | `post_artifact` + `reply` carries files out of T; `local-final` drops files | yes, `daemon/messages.ts:76-79`, `agent-command.ts:861-868` | P1b, P1d |
| 3 | P1 | Order of output vs report; completion joins after R2 | yes | R2 dropped; P1e |
| 4 | P1 | After a handover, `done:` on the original order goes to C1 | yes | the §3 rule (all non-person thread reports → commander) |
| 5 | P1 | A plain-language blocker bypasses escalation and tracking | yes | `reply` text keeps the prefix grammar; the §3 rule no longer depends on prefixes for routing |
| 6 | P1 | A grant continuation reports to the approver (pinned test) | yes, `approval-resume-routing.test.ts` | kept: a person-issued resume in T goes to that person (T17) |
| 7 | P1 | A reviewer's continuation loses its implementer return | yes | reviewer role rule (§3), T18 |
| 8 | P1 | Watched merge reports into the archived T and cancel | yes, `system-line.ts:457-466` | System issuer → session room (§3), T19 |
| 9 | P1 | A connected app has no unique pending turn | yes, `rooms-mcp-agent.ts:380-397` | P2d binds to the received command id |
| 10 | P1 | Connected apps and old helpers can still post or message elsewhere | yes | **Accepted residual.** Body's thread surface removes it. A server-side refusal would be a new restriction the owner has not sanctioned, so it is offered as D4 |
| 11 | P1 | R2 changes old-image behaviour during rollout | yes | R2 dropped (Phase 1 leaves `return_room_id`) |
| 12 | P1 | A progress post plus silence completes an order | yes, `operation-effects.ts:222-226` | fixed by dropping R2 (the check keeps matching `return_room_id`) |
| 13 | P1 | D1 leaves the ordering agent asleep; the idle notice is corner-only | yes | D1 for the owner, wording strengthened |
| 14 | P1 | An offline batch republishes the final per item | yes, `agent-command.ts:821-837` | P1c, T21 |
| 15 | P2 | I1–I3 blind spots and over-acceptance | yes | the I3 full-address comparison; per-request route asserts in T9 |
| 16 | P2 | "thisCornerAddress" is a placeholder; self-opened nested destination | yes | `room` optional; two nested rows plus T22 |
| 17 | P2 | Prompt still says to send deliverables via `reply` (repo-less, batch) | yes, `prompt-assembly.ts:449`, `place-prompt.ts:208` | deleted (§4.3) |

- **D4 (new, from Astra #10).** Enforce "output never leaves a thread" on the server for connected apps and old helpers too: a `postCornerMessage` / `message` from a thread command to another place is refused. Recommended: no, not without the owner's explicit approval (standing rule). The Body thread surface plus the I1 production query is the proposal.
