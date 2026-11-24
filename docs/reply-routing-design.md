# Reply routing: answer where the work happens

Status: DESIGN, not implemented. Branch `fm/reply-routing-design`. Code lines refer to `main` at `4f396c7d9`.
Evidence files (`prod-human-messages.txt`, `astra-prompt.md`, `astra-output.md`, `ruby-faults.md`) live beside the working copy of this design in Firstmate's `data/reply-routing-design/`, not in this repository.

## 1. Problem

Owner, 24 Nov: *"Why does ruby print nothing in a multi turn thread that lasted hours?"*

Ruby's thread answers went to #beeline, the chat the thread was opened from. Here is the cause, traced in code:

1. A person tags Ruby in #beeline. Ruby opens a thread with herself as implementer.
   `daemon/corner-writes.ts:274-276` sets the objective's sender to the *parent command's* recorded sender:
   `from = implementerAgentId===agentId ? (await recordedMessageRoute(db,parentCommand)).from : {agent:agentId,place:commandRoomId}`.
   That is `{owner, #beeline}`. The `corner_objective` row's `private_payload.route.from`, and therefore `message.route.from`, become `{owner, #beeline}`.
2. Every turn Ruby ends in the thread posts its closing text via `answerQueuedMessage` (`agent-command.ts:886-919`). That sends to `recordedMessageRoute(item).from` (`message-route.ts:7-11`), which is `{owner, #beeline}`. So the answer is posted in #beeline (`sendMessage` with a human `to`, `agent-messaging.ts:119-123`).
3. Continuations of that turn inherit the same address. Approval and grant resumes, `vault_saved`, `app_connected`, and choice answers that wake the asker with `parent` all take one of two routes:
   - The payload copy at `agent-command.ts:690-692` (`{...parent.private_payload, kind:'lifecycle'}`) keeps `route` and `replyAddress`.
   - The return expression at `agent-command.ts:719-723` falls through to `parent.return_room_id` / `chat.parent_source`.

   Each of them posts in #beeline again.
4. On top of that, `agent-command.ts:870-873` posts any *later, different* reply to an answered command "as an ordinary message where the answer went", again in `return_room_id`. A single ask can therefore produce unlimited routed posts.

So the thread showed nothing, and #beeline got every turn's output.

## 1b. Production evidence (read-only, 22–24 Nov, #beeline `bb91a1c7…` and #apm `b5d1673f…`)

Queries were run through the read-only Neon route. The raw owner and human lines are in `prod-human-messages.txt` next to this file.

- **All 22 of Ruby's `corner_objective` rows in the window have `result_message_id` in the source chat, not the thread.** 20 return to #beeline, one to `latency-batch-1122`, one to #apm.
  - Four threads have zero Ruby posts inside them: `pill-faces-truth`, `Slow-thread-and`, `Release-migration-locks` and `Merge-gate-no`. This is the owner's "prints nothing in a multi turn thread".
  - Human-commissioned self-opened threads post the answer as a plain #beeline message addressed to the owner, for example `thread-handoff-gaps`, `agent-run-pills` and `applied-model-truth`.
  - Claude-opened threads post it as `agent-command` reply cards to Claude in #beeline: 24 Nov 02:08 "Opened reply-quote-preview…", 02:17, and 02:42 "The fix is up as PR #122". The `Slow-thread-and` objective ran 8 commands and left nothing in the thread.
- **Reply ping-pong across places.** Ruby has about 30 `reason='reply'` rows woken in #beeline or #apm whose `return_room_id` is another thread (`card-feed-1123`, `latency-rig-patch`, `composer-tray`, `one-avatar-system`, …). Each informational reply woke the other agent in a third place. This is the volume behind the owner's 22 Nov 14:24 "agent to agent messages … a bit messy".
- **Minerva (`@grunt`) in #apm.** The `epic-chronicle-3d` objective has `return_room_id = #apm` and no result. This fits the owner's 23 Nov 03:21 "grunt is doing work both in the chat scratch space AND in the thread": thread answers would surface in #apm.

### Symptom classification

**Same bug: R1, a thread objective answers in its source chat.** Fixed by S1 and S3c, plus deleting `corner-writes.ts:274-276`.
- 24 Nov "Why does ruby print nothing in a multi turn thread that lasted hours?"
- 22 Nov 19:21 "many example threads … print no output" (the *no output* half).
- 22 Nov 20:13 "printing no output in the thread".
- 23 Nov 03:21 #apm "grunt … doing work both in the chat … AND in the thread" (the thread-answers-in-chat part).
- Reply cards to Claude in #beeline for threads Claude opened (24 Nov 02:08–02:42).

**Same family: R2, inherited and repeated routing.** Fixed by S2/S4 (no inheritance, at most once) and by D1 (informational replies wake no one unless asked).
- Replies routed into third places: the ~30 `reply` rows above, each a *first* reply that woke its recipient somewhere other than the replier's work place. The "ping-pong" is that each first reply is routed. It is not an acknowledgement loop, because acknowledging an informational reply is already transcript-only (`agent-messaging.ts:68-73`). This correction came from Astra.
- Watched-thread wakes answering through an inherited `replyAddress` to the owner. On 24 Nov 01:15, message `9324088b` has `replyAddress {owner, #beeline}` copied from the watch's incoming command.

**Related routing, but a separate defect: B1, a block reaches an agent opener instead of the commissioning person.**
- On 23 Nov 22:12, `a9cd6158`, `blocked:` from `Slow-thread-and` was delivered to **Claude** (`reportToId` = Claude). Claude had opened the thread on the owner's request.
- It sat in #beeline and reached nobody's Tasks list. Owner, 24 Nov 03:16: "why did you simply print this here instead of messaging your commander?"
- `blockRecipient` → `threadCommanderAddressSql` picks the opening task's sender, which is the agent. The owner's reply rule does not decide this. It needs its own decision (D4).

**Separate, not routing: B2, background-wake noise.** A watched-thread wake produced "Nothing for me to do here…" (24 Nov 01:15). Owner, 03:16: "why did you print this when you said the message is not worth printing".
- Folded in by Firstmate's instruction: see §4b, which deletes the contradicting prompt sentence at `apps/body/src/prompt-assembly.ts:446`.

**Not routing (listed for the owner and kept out of this design):**
- **Turn and status state:** "working but state marked as idle" (22 Nov 14:39), "status is marked as blocked" with no blockers (15:34), "thread is marked as working as nothing is happening" (15:36), "why this thread turn idle instead of staying on waiting" (21:50), "Grunt still shown to be working" (24 Nov 02:51).
- **Missing wakes:** "1 check failed – why did this not wake you" (22 Nov 15:37), "why did this not trigger" (19:15, schedule), "how will you be notified when it finishes" (15:22).
- **Stop:** "pressing stop on your turn doesn't work either" (22 Nov 22:28). The "user stopping an agent turn wakes the commander" report (14:43) was fixed by the merged "no idle notice after a person's stop".
- **Thread boundaries:**
  - Agents push commits to feature branches with no PR, or run CI on local copies (22 Nov 19:21, 19:32, 20:13).
  - Grunt codes in chat scratch (23 Nov 02:32, 04:38).
  - Claim and handoff: "claim_thread before work", "can't reach yourself in a thread" (14:43, 20:19). The latter was fixed by the merged self-wake change.
- **Agent stops silently with no output:** Grunt, 23 Nov 03:11 and 24 Nov 02:19 (provider stop).
- **Model and grants:** Emberus shows Astra but runs Sol (22 Nov 16:55); a grant only valid next session (19:19).
- **UI:** pills, cards, composer, avatars. Out of scope.

## 2. The rule

> "Replies can only be routed if the initial message asked for one, and then it can only be sent once."

### Definition (verbatim; owner's proposal, refined)

> **A turn is run by exactly one session = (agent, place) = (`agent_commands.agent_id`, `agent_commands.room_id`) of the command that started the turn.** That session's own output is posted in `room_id`. Output means its closing text, its `reply(id)` answer and its `report` answer. Nothing else decides placement: not ancestry, the handover, the opening route, the parent's return place, the schedule or workflow owner, or another session of the same agent.
>
> **The only exception is a `reply_to` delivery:** exactly one message per `reply_to`, posted at `reply_to.place` to `reply_to.agent`'s session, and only when `reply_to` was set by an explicit ask (S3, which records the ask kind in `reply_to.ask`).
>
> **A `message()` or `post(address)` is not output.** It is a new message whose place the session names explicitly. When it, or a block, is aimed at a thread's commander, its place is the commander's place (Rule 2, S8).

One refinement over the proposal: the proposal's "every answer message" needed a way to tell answers from deliberate sends. A turn's explicit `message()` to a person carries the turn's `request_id` today (`agent-messaging.ts:119-122`). So does `post(address)` (`daemon/corner-messages.ts:15-19`). To make that distinction mechanical, the single message funnel (`queueMessage` / `sendMessage`) stamps every agent-authored row with a new column, `messages.turn_write text CHECK (turn_write IN ('output','reply','message','post'))`. It also stamps `messages.turn_command_id`, the command whose turn wrote it, and a `reply` row additionally records `reply_request_id`.

### Check (verbatim; each query must return zero rows)

```sql
-- I1 placement: a turn's own output is in its session's room.
SELECT m.id FROM messages m JOIN agent_commands c ON c.id = m.turn_command_id
 WHERE m.turn_write = 'output' AND m.room_id <> c.room_id;

-- I2 the exception, at most once and only when asked: every 'reply' row is the
-- one spend of an explicitly asked request, at its reply_to place, to its agent.
SELECT m.id FROM messages m
  LEFT JOIN agent_commands r ON r.id = m.reply_request_id
 WHERE m.turn_write = 'reply'
   AND (r.id IS NULL OR r.reply_to IS NULL OR r.reply_to->>'ask' IS NULL
        OR r.reply_sent_id IS DISTINCT FROM m.id
        OR m.room_id::text <> r.reply_to->>'place'
        OR COALESCE(m.card->'recipient'->>'id', m.card->'route'->'to'->>'agent')
           IS DISTINCT FROM r.reply_to->>'agent');
SELECT reply_request_id FROM messages WHERE turn_write = 'reply'
 GROUP BY reply_request_id HAVING count(*) > 1;

-- I3 commander sessions (Rule 2): nothing aimed at a thread's commander wakes
-- that agent inside the thread. Excluded: a person's own tag of it there, and
-- the agent's message to itself.
SELECT q.id FROM agent_commands q JOIN rooms t ON t.id = q.room_id AND t.parent_id IS NOT NULL
 WHERE q.agent_id = (commanderAddress(t.id))->>'agent'
   AND q.reason IN ('message','reply','report','system','order')
   AND COALESCE(q.message->'route'->'from'->>'agent', '') <> q.agent_id;
```

I1–I3 run as a server test over every scenario in §6, and as a read-only production query after rollout. `commanderAddress` is the S8 resolver exposed as SQL.

These terms are used precisely below:

- **Work place**: the session's room, `agent_commands.room_id`, per the definition above.
- **Routed reply**: an answer that goes anywhere other than a plain post in the work place. That means one of two things:
  - it is posted in another room;
  - it wakes another agent's queue (a `reply` command).
- **Explicit ask**: a structural field on the *triggering* record, set by its sender's deliberate act. Text never counts ("let me know" in prose is not an ask), and neither does ancestry, a handover or an owner lookup.
- **Once**: one routed delivery per explicit ask, across every command that continues it: resumes, batch siblings, late replies and re-deliveries.

## 2b. Sessions: every address is (agent, place)

Owner, 24 Nov: *"the same agent Ruby living in #beeline (chat) and one of its threads do not share the same session and context."*

An agent has a separate session, with its own context and its own conversation with the person, in each place. "Ruby" is therefore never an address on its own; "Ruby in #beeline" is. Two rules follow:

- **Rule 1 (answer where the work happens) covers the worker's own output only.** That is the closing text and its posts in its work place.
- **Rule 2 (commander address).** Anything aimed at a thread's commander reaches the commander's session in **the place it commanded from**: a `blocked:` / `needs-decision:`, an explicitly requested reply, or any `message` to the commander. That place is where it called `open_thread`, gave the order, or (after an approved handover) revised the brief. It never reaches that agent's session inside the thread. Spine rule S8 implements this.

## 3. Spine

**S1. Every answer goes to the work place by default.** For new rows, `return_room_id` is written as `room_id`. Readers stop branching on it, and the column is dropped after the rolling-release window (§7). The whole `returnRoom` / `returnIdentityId` derivation at `agent-command.ts:706-723` is deleted.

**S2. A reply request is a row fact on the asking command.** Two new columns:

- `agent_commands.reply_to jsonb` holds `{agent, place}` and is set only by the explicit asks in S3.
- `agent_commands.reply_sent_id text` is the spent marker.

A third column, `agent_commands.reply_request_id text`, points at the row that holds the request. It is the row's own id for the asking command. It is copied from `parent.reply_request_id` only by the continuation rule S4d. Nothing else copies it, so a new ask always starts a new request.

**S3. The only writers of `reply_to` (the explicit asks):**

| # | Explicit ask | `reply_to` |
|---|---|---|
| a | `message(to, text, reply:true)` (new boolean, default false) | sender @ sender's place |
| b | `message(..., ask)` or a `blocked:` / `needs-decision:` message: an ask is a request for an answer by definition | sender @ sender's place |
| c | `open_thread(..., reply:true)` (new boolean, default false) | **the thread's commander address** (S8): the opening's `route.from`. That is the opener @ the place it called `open_thread` from, or, when the opener is its own implementer, the parent command's sender @ its place. The latter is the owner's case: Ruby @ #beeline asks Jellybean to open a thread, and Jellybean opens it for itself |
| d | System review dispatch (`corner_review_dispatch`): the product contract is that findings reach the implementer | implementer @ thread (same place, so this is "wake the implementer", not a cross-room post) |
| e | Legacy `order` (cutover-only tool; its contract is "the result reports to the orderer") | orderer @ `fromRoomId`. Derived at spend time from `private_payload.authorId` / `fromRoomId` when `legacyCommandPayload()` holds, because legacy orders carry no `message.route` (`agent-command.ts:758-763`) and old images keep writing them during the overlap (Astra #3) |
| f | A schedule whose `owner_id` is another **agent** (an agent set up a recurring task to report to it; `agent-schedules.test.ts:71-97`) | that agent @ the schedule's room, once per run. A human owner in the same room is a plain post (Astra #19) |

None of these ever produce a reply address: handover `commanderReturnRoomId` / `source_room_id`, the opening route, `parent.return_room_id`, `parent_source`, a human schedule owner, the workflow owner, `report_address`, `escalation`, `continuesCornerWake`, and inherited payload `route` / `replyAddress` / `returnIdentityId`.

**S4. Spending a request once.** Every answer exit (closing text, `reply(id)`, `report(status)`, batch answers) does this:

```sql
UPDATE agent_commands SET reply_sent_id=$answer
 WHERE id=$reply_request_id AND reply_to IS NOT NULL AND reply_sent_id IS NULL
 RETURNING reply_to
```

- If a row comes back, the answer is delivered to `reply_to` through the existing `sendMessage` path.
- If none comes back, the answer is a plain post in the work place under the worker's name, with no wake and the receipt *"Posted here; the request's reply was already sent (or none was asked). Use message() to reach someone."*

The conditional update is the at-most-once guarantee. **Lock order** (Astra #17): every answer exit locks the request row (`SELECT … FROM agent_commands WHERE id=$reply_request_id FOR UPDATE`) *before* any item row. The batch path locks all distinct `reply_request_id`s in id order first, then the items in inbox order. Without this, a batch (original, then resume) and a single answer (resume, then original) can deadlock.

Refinements from the eng review (§10):

- **S4a. An answer that carries an `ask` does not spend, but only when the request has a `reply_to`.** Without one, `reply(id, ask)` posts in the work place like any reply; the agent uses `message(to)` to reach the sender, which checks its membership there (Astra #5).
  The ask-back row records `resumes_request_id` = the original request. When the asker answers it, the delivered row for the original worker gets that `reply_request_id`, so the worker's eventual verdict still spends the original request exactly once (Astra #6).
  Rest of the original S4a: It is a question back to the asker (S3b makes it its own request). Example: the commander asks a reviewer with `reply:true`, and the reviewer answers "which base?" with `ask`. The reviewer's verdict on a later turn still owes the commander its one reply. This matches today's "a follow-up ask remains a distinct delivery" (`agent-command.ts:874-875`).
- **S4b. The spend and the delivery happen in one explicit `SAVEPOINT reply_request_spend` SQL statement**, following `corner-lifecycle.ts:801`. Nested `transaction()` is *not* a savepoint (`database.ts:538-539`, Astra #17). First check that `reply_to.place` is unarchived and that `reply_to.agent` is still a member there, then spend and deliver.
  - If `reply_to` can no longer be reached, write `reply_sent_id = 'unreachable:<reason>'` (so it is never retried), post the answer in the work place, and say so in the receipt.
  - This replaces today's "a closed return place cancels the item" (`agent-command.ts:896-899, 934-938`; `docs/agent-corners.md:13`). The work place still exists, so the answer is never lost.
- **S4c. Completion is a row fact, not a room match.** An item is answered when `result_message_id` is set by `endAgentTurn`. The idempotency joins at `agent-command.ts:816-817` and `856-857`, and `agent-command-route-agent-result.ts:57-62`, accept `posted.id = result_message_id` in any room, plus a `posted_reply_id` in `room_id`. A routed delivery's transcript row lives in `reply_to.place`, not in `room_id` (`agent-messaging.ts:85-92`), so a room-keyed join can no longer find it. Astra corrected my earlier wording here. The same applies to `replyToMessage`'s `turnComplete` proof (`agent-messaging.ts:144-158`) and to the silence check (`daemon/operation-effects.ts:222-226`). Both join on `return_room_id` and are added to §5 (Astra #16).
- **S4d. Copy rule for `reply_request_id`.** A new command copies `parent.reply_request_id` only when it continues the parent's turn:
  - `input.resume`, or `reason IN ('resume','mcp_call')`,
  - the vault-saved and app-connected continuations, which are already `resume:true` (`vault-save-http.ts:186-195`). `app_connected` sets no `resume` today (`first-party-integrations.ts:42`, `phone/connections.ts:223`), so it must pass `resume:true` to inherit,
  - the choice-answer wake at `room-choice.ts:510`,
  - and `tagged_lifecycle_retry` (`agent-command-create-agent-command.ts:132-155`), so a person's retry of a failed asked task still owes the asker (Astra #14).

  Everything else gets a fresh `reply_request_id` (self) or none. It is one rule in one place, not a list in every caller.
- **S4f. For an asked request, a local post is progress, not the reply (Astra #10).** `posted_reply_id` is recorded for a work-place post only when the item's request has no unspent `reply_to` (`agent-command.ts:582-588`). For the same reason, silence (`no_reply_needed`) on an item with an unspent `reply_to` leaves it queued (`answered:false`). That matches today's "an owed answer stays queued" for request reasons. Only the spend, or an `unreachable:` mark, discharges an asked request.
- **S4g. Batch receipts are keyed by request (Astra #9).** The batch path (`agent-command.ts:811-837`) keys shared deliveries by `reply_request_id`, never by `[return_room_id, agent]`. With S1 every row's return place is its own room, so the old key would merge independent requests.
- **S4e. One owner.** `reply_to` is written only in `insertAgentCommand`. It is spent only by `spendReplyRequest()` in a new owner file, `apps/server/src/reply-request.ts`. A new `docs/architecture/invariants.json` sink rule enforces both. `agent-command.ts` is at 993 of 1,000 lines, so the new logic cannot live there.

**S5. Blocks are new asks, not replies.** A `blocked:` / `needs-decision:` text is the *worker's* new message to the thread commander (`blockRecipient`, `implementer-blocks.ts:49-55`). It keeps going there. A block never spends the objective's request.

Each block is its own ask (S3b), and its answer comes back into the block's thread **once per ask**. Today `wakeBlockAnswer` deduplicates by *answer message id* (`implementer-blocks.ts:89`), so two human replies wake the implementer twice (Astra #4). After this design:
- A second answer before the implementer has run coalesces into the pending wake (`coalesced_context` already exists, `agent-command.ts:114`).
- A second answer after it ran stays visible in the reply chain and wakes no one.
- The implementer re-asks in the chain to open the next answer (`block_reasked_at`, as `blockReminder` already instructs).

**S8. Commander address (Rule 2).** One resolver, `commanderAddress(thread)` in `reply-request.ts`:
- It returns the approved handover's `(author_id, commanderReturnRoomId)` when one exists. Otherwise it returns the opening task's `route.from` (`threadCommanderAddressSql`, minus `replyAddress`, per S6).
- It is applied at **every** delivery whose recipient is that thread's commander agent and whose destination place is the thread or one of its descendants. That includes:
  - `message`,
  - `reply`,
  - a `reply_to` spend,
  - a block,
  - a legacy `report`,
  - an idle or attention notice.
- It **rewrites** the destination place to the commander's place. It never refuses, so it adds no wall.

This generalises `blockRecipient` (`implementer-blocks.ts:49-55`), which today does it for block prefixes only. `messageAddress` (`agent-messaging.ts:24-35`) also gains the role `commander`, so `to:{agent:'commander', place:thread}` resolves to the commander address the same way `implementer` and `reviewer` already resolve.

The one exception is an agent's message *to itself* (the self-wake, `agent-messaging.ts:62-67`). That is the agent's own deliberate choice of session, not a delivery to "the commander".

**S9. A self-opened thread inherits its opening turn's request.** When a turn opens a thread with itself as implementer, the open moves the turn's unspent `reply_request_id` onto the `corner_objective`. The opening turn's own closing text ("opened X") then posts in its place without spending.

Example: Ruby @ #beeline asks Jellybean with `message(reply:true)`, and Jellybean self-opens. Ruby's one reply is then the thread's result, delivered to Ruby @ #beeline, not "opened the thread". A person's tag carries no request, so the owner's own self-opened threads are unaffected and still answer in the thread.

**S7. A person as the asked party (Astra #12).** `message(to: person, reply:true)` writes a plain `messages` row, not a command, so the request lives on the message. Its card carries `replyTo {agent, place}`, and a new `messages.reply_sent_id` is the spent marker. The existing block-answer hook is generalised from blocks to "an asked message": a person's reply in that message's chain wakes `replyTo` once, through the same S5 coalescing. A choice-card `ask` keeps its own return (`room-choice.ts:488-511`).

**S6. Who the commander is stays separate from where replies go.** The opening's `route.from` keeps its current value. For a self-opened thread that is the commissioning person (`corner-writes.ts:274-276`, **not deleted**). Otherwise `threadCommanderAddressSql` would name the worker itself, and `blockRecipient` would fall back to the worker's own address, sending its block to itself (Astra #7). `threadCommanderAddressSql` must read `route.from` and stop preferring `message.replyAddress` (`corner-commander.ts:29`). The rest of the original S6: `threadCommanderAddressSql`, `cornerCommanderIdSql`, `commanderChainSql` and handover revisions keep deciding *authority*: who may close blocks, stop turns, revise briefs, and who receives blocks. They no longer decide where ordinary answers go.

## 4. Flow table

"Today" is traced from code. "After" applies S1–S6. "Explicit ask" is what the sender must do to get a routed reply.

| Flow | Today | After | Explicit ask |
|---|---|---|---|
| Person tags agent in chat P | Answer in P (`human_tag`, no payload, `returnRoom=chat.id`) | Same | n/a (same place) |
| Person in DM | Answer in DM | Same | n/a |
| Person tags agent in a thread | Answer in thread | Same | n/a |
| **Thread objective, self-opened** (Ruby's case) | Every turn's answer goes to the owner in #beeline (route from parent command) | Answers stay in the thread. The #beeline tag got its one answer from the opening turn in #beeline; the corner-open card links the thread | none possible: the person asked in #beeline and was answered there |
| Thread objective, agent opens for another agent | Implementer's answers wake the commander in the opener's chat, every turn | Answers stay in the thread. With `open_thread(reply:true)`, the first answer wakes the commander once | `open_thread(reply:true)` |
| Thread objective after a human-approved handover | Answers go to `commanderReturnRoomId` | Stay in the thread. **Correction (Astra #8):** today a block does *not* follow the handover. `threadCommanderAddressSql` reads the first task and wins over the approved revision in both `blockRecipient` and `cornerCommanderIdSql` (`corner-commander.ts:15-32`). That is a pre-existing gap. **Revised 24 Nov (Rule 2):** S8 resolves the commander through the approved handover, so blocks go to the new commander's session at `commanderReturnRoomId` | n/a |
| Corner lifecycle wakes (checks failed, merge conflict, merge refused, review needed, subscribed event in a corner) | Thread (`cornerWake`, line 711) | Same, with no special case | n/a |
| Brief-revision wake | Reply returns to the reviser at the reviser's place (`replyAddress` reset, line 700; `route.from` = reviser) | Stays in the thread. A reviser who wants an acknowledgement sends `message(reply:true)` | `message(reply:true)` |
| Review dispatch → reviewer findings → implementer | Reviewer's answer wakes the implementer in the thread (`replyAddress` = worker, line 701); repeats are deduplicated by answer id | Same, by S3d, but once per dispatch; a later reviewer turn posts in the thread | system (S3d) |
| Commander → reviewer `message("Review this PR")` across places | Verdict returns to the commander at its chat | Verdict stays in the reviewer's place unless `reply:true` | `message(reply:true)` |
| Implementer → commander `blocked:` / `needs-decision:` | Delivered to the thread commander (`blockRecipient`) | Same (S5), and the answer returns once into the thread | the block prefix is the ask |
| Legacy `report(status:blocked/needs_decision)` | `report_address` / `escalation` | Same as blocks (S5) | prefix/status |
| Legacy `report(status:done/failed)` | `report_address` / `escalation`, every call | Delivered once only if the item's request has `reply_to`; otherwise posted in the thread | the request's ask |
| Agent → agent `message()` in another chat (Jellybean → Ruby @ #beeline) | Delivered to Ruby @ #beeline (the message itself). Ruby's answer returns to Jellybean @ thread | The message is still delivered; it is a new message, not a reply. Ruby's answer stays in #beeline unless Jellybean set `reply:true` (implicit for blocks and asks) | `reply:true` / ask / block |
| Agent → agent `message()` in the same place | Recipient's answer queues a `reply` command for the sender (wakes it) | Answer posted in place; the sender is woken only if it asked | `reply:true` |
| Agent → person `message(to:{H, CHAT})` | Posted in CHAT (a new message) | Same | n/a |
| Person answers an agent's choice card | Asker woken at `origin.route.from.place` with `parent`; the answer inherits the parent's route and goes to the parent's sender | Asker woken at its place (unchanged). Its continued answer spends the parent's request if still unspent, else stays in the place | inherited request only |
| Approval / grant / vault / app-connected resume | Inherits the parent's route, so a second routed answer | Shares the parent's `reply_request_id`; at most one routed answer across both | inherited request only |
| Scheduled wake, human owner | Answer in the schedule's room, addressed to the owner (`scheduledReturn`, line 682) | Same room, a plain post | n/a |
| Scheduled wake, owned by another agent | Result queued privately to the owning agent (`agent-schedules.test.ts:71-97`) | Delivered to the owning agent once per run (S3f) | `owner_id` = an agent, set at schedule creation |
| Agent asks a person `message(to:H, reply:true)` from a thread | Posted in H's place. H's plain reply wakes no one unless it is a block | H's first reply in the chain wakes the asker in its thread once (S7) | `reply:true` |
| Workflow assignment / resume | Room of the run, `replyAddress` = workflow owner in the same room | Same room | n/a |
| Watched-thread wake (commander's watch fires) | Returns via `parent.return_room_id`, which can be another chat | Watcher room | n/a |
| Sentry / attention reports / idle notices | Room woken in | Same | n/a |
| Voice order | Room of the call | Same | n/a |
| `mcp_call` (app tool call) | Parent route | Shares the parent request | inherited |
| Late, different reply after an answer (`agent-command.ts:870-873`) | Posted again in `return_room_id` | Posted in the work place | never routed |

## 4c. Which session receives each flow (Rule 2 re-check)

Notation: `X@P` is agent X's session in place P. C = the thread's commander, I = its implementer, T = the thread, P = the place C commanded from.

| Flow | Today: receiving session | After: receiving session | Wrong session today? |
|---|---|---|---|
| I's own output in T | I@T (posted to C@P for objectives, R1) | I@T, posted in T | posting yes (R1); session n/a |
| I `blocked:` / `needs-decision:` via `message` / `reply` | C@P via `blockRecipient` → `threadCommanderAddressSql` (`implementer-blocks.ts:49-55`) | C@P (S8) | no |
| I legacy `report` (any status) to its commander | **C@T**: `wakeHere` queues the report in the *reporting thread* (`agent-command.ts:511-520`), pinned by `commander-opening.integration.test.ts:30` ("handback wakes its commander in the corner") | C@P (S8); `wakeHere` deleted | **yes** |
| Nested thread: the outer worker W commands the inner thread from outer thread O | **W@inner** for a legacy report (same `wakeHere`; `commander-opening.integration.test.ts:98`); W@O for a modern block | W@O | **yes** (legacy path) |
| Any `message(to:{C, place:T})` from I or another agent | **C@T**: `messageAddress` resolves C at T and queues there (`agent-messaging.ts:24-35, 74-81`). Production, last 7 days: 15 such wakes. Example: in `connector-tag-expiry` (commanded by Ruby from #beeline), Claude's messages woke **Ruby@thread**; Ruby@thread replied to Claude@thread | C@P (S8 rewrite); `to:{agent:'commander'}` role added | **yes** |
| Connected-app `message` with no `address` and no queued item | Sender's place defaults to `to.place` (`rooms-mcp-agent.ts:191` "omit to send from to.place"; `:390` `item?.room_id ?? target`), so the recipient's reply wakes **the sender's session in the destination**. Production: in `Slow-thread-and`, Ruby's replies woke Claude@thread; Claude had commanded it from #beeline | the sender's session for a connected app is its *current* place. With no queued item, the default is the place it is posting from (its pending turn's room), never `to.place`; a commander sender still resolves via S8 | **yes** |
| An explicitly requested reply to C (`open_thread(reply:true)`, `message(reply:true)`) | C@`return_room_id`, which for an objective is P (mostly right, by accident of R1) | C@P via `reply_to` = commander address (S3c, S8) | no |
| The Ruby → Jellybean self-open (owner's case) | Blocks reach Ruby@#beeline; a `message(to:{ruby,T})` or a legacy report reaches **Ruby@T** | All reach Ruby@#beeline. Ruby's one reply is the thread's result (S9) | **yes** (two paths above) |
| Idle / attention notices to C | C@P (`reportAgentAttention` uses `commanderReportAddress` → `route.from`, `commander.ts:247-268`) | C@P | no |
| Watched-thread wakes (opened, merged) | the **opener**@`open_thread` call place (`corner-writes.ts:293-296`). For a self-open on someone's behalf that is Jellybean@#beeline, so Ruby, the commander, gets no watch | the watch is created for `commanderAddress()` (C@P) | **yes** (self-open on behalf) |
| Review dispatch / findings | reviewer@T → I@T | same | no |
| After an approved handover to C2 | blocks still to the *original* C@P (`corner-commander.ts:15-32`, Astra #8) | C2@`commanderReturnRoomId` (S8 prefers the handover) | **yes** (stale commander) |
| A person tags C inside T | C@T works there and answers in T (Rule 1; a person chose that session) | same | no |
| C messages itself at T (self-wake) | C@T (`agent-messaging.ts:62-67`) | same (own choice, excluded from S8) | no |

Flows where today's code already sends to the wrong session:
1. the legacy `report` `wakeHere`, including its nested variant;
2. `message` addressed to the commander at the thread;
3. the connected-app sender-place default;
4. the post-handover block recipient;
5. the self-open watch going to the opener rather than the commander.

All five are fixed by S8 plus the deletions in §5.

## 4b. Ruby's two faults: same flow map, prompt deletions only

These come from the owner via Firstmate (`ruby-faults.md`), checked against `main` `4f396c7d9`. No server-side refusal is added: Ruby's proposal to refuse untagged `blocked:` / `needs-decision:` posts is **rejected**, because it would be a new wall.

| Flow | Today | After | Explicit ask |
|---|---|---|---|
| A background or notice wake with nothing actionable (24 Nov 01:15: "Nothing for me to do here", posted to the owner in #beeline) | The room rule at `apps/body/src/prompt-assembly.ts:446` says both "If nothing is actionable for you, do not reply" **and** "If the current task is only a nudge to respond, answer the most recent unanswered human message". The background line at `:823` says to call `no_reply_needed`. A landed-merge notice fits both, so Ruby posted. An inherited `replyAddress {owner,#beeline}` (R2) made the post look addressed to the owner. | One rule for every wake: nothing actionable means post nothing (`no_reply_needed`). The server already ends a background item with empty output silently (`agent-command.ts:889-893, 950-955`). R2 removes the inherited address. | n/a |
| A decision or block from the work place (23 Nov 22:12 and 24 Nov 03:16: a decision posted as untagged text, so no card and no Task) | The tool and guide text tell agents "Blocks (blocked:/needs-decision:) are plain text by default": `packages/api-contract/src/agent-messaging.ts:31` (`ASK_TOOL_TEXT`), `packages/api-contract/src/beeline-guides.ts:109`, `apps/server/src/implementer-blocks.ts:38` ("Use plain text unless real options help"). Ruby read "plain text" as "a plain chat post". | A block or decision **is an explicit ask aimed at a named person** (S3b). It goes through `message(to:{person or commander})` or `reply`, which already create the Tasks item and the reply chain (`agent-messaging.ts:50-52, 99-117`; `implementer-blocks.ts:77-94`). Plain text is still allowed as the *content*: the "Use choices only when real options help" sentence stays, per the owner on 22 Nov 16:16, "He can simply ask for a text reply". | The block prefix and a named recipient |
| "Reply to the message that gave you the task when done, blocked or failed … its id already records the reply destination" (`beeline-guides.ts:107`) | It says every task's id carries a return address. | It contradicts S1, because a destination exists only when the message asked. The clause is deleted, and `reply`'s tool text (§5) says what happens. | — |

Exact deletions, with nothing added:
1. `apps/body/src/prompt-assembly.ts:446`: delete the sentence `If the current task is only a nudge to respond, answer the most recent unanswered human message instead of echoing the nudge.` The remaining sentence, "If nothing is actionable for you, do not reply.", is the one rule. The `:823` background text already matches it.
2. `packages/api-contract/src/agent-messaging.ts:31`: delete `Blocks (blocked:/needs-decision:) are plain text by default; omit digest fields and ask for a plain reply.`
3. `packages/api-contract/src/beeline-guides.ts:109`: delete `Blocks (blocked:/needs-decision:) are plain text by default and also create a Tasks item for their recipient.`
4. `apps/server/src/implementer-blocks.ts:38`: delete `Use plain text unless real options help.` The guide sentence "Use choices only when real options help" already says this once.
5. `packages/api-contract/src/beeline-guides.ts:107`: delete `its id already records the reply destination`.

Tests:
- Regenerate the rendered prompt snapshots that carry these strings: `docs/prompts/surface.json`, `docs/prompts/room.md` and `docs/prompts/room-squire.md` (via `packages/scripts/prompt-surface.ts`).
- [EVAL] On the live-harness rig, a landed-merge `watched_corner` wake ends in `no_reply_needed`, and a needs-decision from a `human_tag` turn goes to the owner as a `message` that creates a Tasks item.

## 5. What gets deleted

`apps/server/src/agent-command.ts`:
- 670 `handover` as a payload source, 692-693 `handover ? {...fromRoomId: commanderReturnRoomId ?? source_room_id}`.
- 690-692: the inherited-payload spread loses `route`, `replyAddress` and `returnIdentityId`. Inherit `text`/`attachments` only, plus `reply_request_id`.
- 701 `replyAddress` for review dispatch moves to the `reply_to` column (S3d); 700 is deleted (no inheritance to reset).
- 706-713 `parentReturn`, `continuesCornerWake`, `cornerWake`.
- 714-720: the `returnIdentityId` expression. (`escalation`, 716-717, stays for legacy order blocks until cutover.)
- 721-723 `returnRoom` becomes `chat.id`.
- 764-767 `message.replyAddress` derivation is replaced by `reply_to`.
- 870-873 late-reply re-post in `return_room_id` becomes a work-place post.
- 886-919 route branch: `recordedMessageRoute(item).from` is replaced by the S4 spend; with no request, post in `item.room_id`.
- 921-924 report recipient: `report_address` / `escalation` stay only for block statuses.
- 186-196: the schema backfills that derive `return_room_id` from the root human or `fromRoomId` are replaced by the §7 migration.

`apps/server/src/daemon/corner-writes.ts:274-276` is **kept** (S6, Astra #7). It records the commissioner as `route.from`, which now only says who commands. `reply_to` is set only when `reply:true` (S3c). `corner-writes.ts:426` `commanderReturnRoomId` stays as authority provenance but is no longer read for replies.

`apps/server/src/corner-commander.ts:29`: `threadCommanderAddressSql` drops `task.message->'replyAddress'` from its `COALESCE` and reads `route.from` first.

`apps/server/src/commander.ts:234` (`reportToCommander` room = `address?.roomId ?? command?.return_room_id ?? …`): non-block reports post in the source thread. `commander.ts:280-288` `cornerReportOpening` stays for block recipients.

`apps/server/src/messaging-cutover.ts:28-31`: the `returnIdentityId` / `return_room_id` fallback in `legacyMessageRoute` is deleted.

Readers switch from `return_room_id` to `room_id`:
- `agent-command.ts:585, 816, 857` (posted-reply matching)
- `agent-command-route-agent-result.ts:58`
- `agent-turn-end.ts:119, 186`
- `owed-mentions.ts:64`
- `daemon/operation-effects.ts:152, 227`
- `rooms-mcp-agent.ts:392`
- `agent-messaging.ts:144-158` (`turnComplete` proof)
- `daemon/operation-effects.ts:222-226` (silence check, plus S4f)
- `agent-turn-end.ts:178-191` (harness-failure line: posts in `room_id`, and leaves the request unspent so a retry still owes it)
- `agent-command.ts:510-520`: the `wakeHere` branch (legacy report wakes the commander in the reporting thread) is **deleted**. The report queues at `commanderAddress()`.
- `rooms-mcp-agent.ts:191` ("omit to send from to.place") and `:390` (`item?.room_id ?? target`): the destination-place default for the sender is **deleted**. The sender's place is its pending turn's room, else the `address` it names.
- `implementer-blocks.ts:49-55` (`blockRecipient`) is generalised into `commanderAddress()` (S8) for all commander-aimed deliveries.
- `agent-command-read-agent-commands.ts:44, 102`. The wire `returnRoomId` stays and equals `roomId`, for helper compatibility; Body only uses it for display, `apps/body/src/place-prompt.ts:174`.

Tool surface (`rooms-mcp-agent.ts`), carried through every adapter that enumerates fields (Astra #13):
- `message` gains `reply?: boolean`: `rooms-mcp-agent.ts:391-397`, `daemon/execute.ts:324-327`, the `message` operation schema in `packages/api-contract`.
- `open_thread` gains `reply?: boolean`: `rooms-mcp-agent.ts:598-605`, `apps/body/src/read-only-mcp-open-corner.ts:38-53`, the `createCorner` contract.
- Old helpers can't send the flag, so their calls behave as `reply:false`. That is the strict reading, and asks and blocks still route.
- `reply`'s description becomes: *"Answers the sender of id where it asked, once, if it asked for a reply; otherwise posts here."*
- `agentMessageText` (`packages/api-contract/src/agent-messaging.ts:65`) gains `Reply goes to: <place>` (or `here`), so the model sees where its closing text lands.

## 6. Tests

Each test follows the repo's reproduction style.

New tests:
1. **Ruby R-thread**: a person tags Ruby in CHAT, Ruby self-opens a thread and answers three turns. Expect one answer in CHAT (the opening turn), three in the thread, and none of the thread answers in CHAT.
2. **Ask once**: `message(reply:true)` A@CHAT → B@THREAD. B answers twice via closing text and once via `reply(id)`. Expect exactly one `reply` command for A, and two posts in THREAD.
3. **No ask**: same as test 2 without `reply`. Expect zero commands for A and all answers in THREAD.
4. **Resume shares the request**: an ask with `reply:true`, then a grant pauses it and the resume answers. Expect one delivery. Answering the parent and the resume in the same batch still delivers once.
5. **Choice answer continuation**: the person answers a card, the asker continues; its answer spends the inherited request only if it is unspent.
6. **Block is its own ask**: an implementer `blocked:` goes to the commander and the commander's answer wakes the implementer in the thread once. A later `done:` doesn't go to the commander unless the objective asked.
7. **Handover**: after a human-approved handover, ordinary answers stay in the thread and blocks go to the new commander's session (S8; see also test 32).
8. **open_thread(reply:true)**: the first answer wakes the opener in its chat, later answers stay in the thread.
9. **Concurrent spend**: two batch siblings sharing a request race and exactly one delivery wins (serialized by the row-level `UPDATE … WHERE reply_sent_id IS NULL`).
10. **Late reply**: a different reply after the first answer is posted in the work place, not the return room.
11. **Ask doesn't spend (S4a)**: A asks B with `reply:true`. B replies with `ask`, A answers, and B's next answer is still delivered to A exactly once.
12. **Unreachable reply_to (S4b)**: archive A's place, or remove A, between the ask and the answer. The answer posts in B's work place, `reply_sent_id` starts with `unreachable:`, the item completes, and nothing is cancelled.
13. **Completion without a room match (S4c)**: a routed delivery to an agent leaves the item `complete`. `dismissAgentCommandWakes` and the batch path do not redeliver it.
14. **Copy rule (S4d)**: `resume`, `vault_saved`, `app_connected` (after `resume:true`), `mcp_call` and the choice-answer wake share one request, while `watched_corner`, `schedule`, `subscribed_event` and the `corner_*` wakes get none. This is a table test over reasons.
15. **Migration**: pending legacy `message` / `order` rows keep one routed reply. A pending `corner_objective` row with `return_room_id <> room_id` answers in the thread.
16. **Rolling overlap**: a row written by the old image (`return_room_id <> room_id`, no `reply_to`) answers in the work place under the new code.
17. **Architecture sink**: `check-architecture.mjs` refuses a `reply_to` write outside `insertAgentCommand`, and a `reply_sent_id` write outside `reply-request.ts`.
18. **[EVAL] tool text**: on the reasoning-surface rig, an agent that opens a thread for another agent and needs its result sets `open_thread(reply:true)`. An agent asking a reviewer elsewhere sets `message(reply:true)`. The `returnPlace` situations in `packages/scripts/prompt-surface.ts:119-141` must be updated so the rendered prompt shows "Reply goes to". The behaviour check runs on the live-harness rig.

19. **Self-opened thread block (Astra #7)**: a person commissions Ruby in P, and Ruby self-opens T and blocks. The block reaches the person (the commissioner stays `route.from`), never Ruby herself.
20. **Block answered twice (Astra #4)**: two replies in a block chain before the implementer runs give one coalesced wake. A third, after the run, wakes no one until the implementer re-asks.
21. **Ask-back chain (Astra #6)**: A asks B with `reply:true`. B sends `reply(id, ask)`, A answers, and B's verdict on the new `reply` row is delivered to A once.
22. **reply(id, ask) without a request (Astra #5)**: it posts in B's place, and nothing is delivered to A's private P.
23. **Batch with two independent requests (Astra #9)**: two separate deliveries, to P and to Q.
24. **Progress then silence (Astra #10)**: an asked item with a local progress post and `no_reply_needed` stays queued.
25. **Legacy order written by the old image after the backfill (Astra #3)**: the answer reaches the orderer once, through S3e at spend time.
26. **Agent-owned schedule (Astra #19)**: `agent-schedules.test.ts:71-97` keeps passing, with one delivery per run.
27. **Person asked (S7)**: `message(to:H, reply:true)` from T, H replies in the chain, and the asker is woken in T once.
28. **Deadlock order (Astra #17)**: a concurrent batch (original, then resume) and a single answer (resume) both commit, with one delivery.

29. **Named test: "Commander session (Ruby → Jellybean)"** (owner, 24 Nov). Ruby@#beeline sends `message(to: jellybean@#beeline, reply:true)` "open a thread for X", and Jellybean self-opens T. In T, Jellybean sends:
   - (a) `blocked:` via `reply`,
   - (b) `message(to:{ruby, T})`,
   - (c) `message(to:{commander, T})`,
   - (d) a legacy `report(status:'needs_decision')`,
   - (e) its objective's closing text.

   Expect (a)–(d) to create commands with `agent_id=ruby, room_id=#beeline`, and (e) to be Ruby's one reply at #beeline. **Zero** commands with `agent_id=ruby, room_id=T`. Jellybean's opening turn's "opened T" posts in #beeline without spending (S9). I1–I3 return nothing.
30. **Named test: "Two active corners"** (owner, 24 Nov). Ruby is implementer in T1 and T2 at once (commanded from #beeline by the owner and by Claude), with interleaved turns: each closes, posts progress, and blocks. Expect:
   - every T1 output row in T1 and every T2 output row in T2 (I1);
   - T1's block to the owner @ #beeline, and T2's block to Claude @ #beeline;
   - Ruby@#beeline woken by neither unless asked;
   - a `reply_to` on T2's objective (Claude asked) spent once, at #beeline (I2);
   - no command for Claude in T2 (I3).
31. **Connected-app sender place**: Claude, with no queued item, sends `message(to:{ruby, T})` from #beeline. The reply wakes Claude@#beeline, not Claude@T.
32. **Handover commander**: after a human-approved handover to C2 from Q, I's block goes to C2@Q.
33. **Invariant suite**: I1–I3 run after tests 1–32 and return zero rows.

Tests that flip, rewritten to the new contract:
- `commander-opening.integration.test.ts:30` ("handback wakes its commander in the corner") and `:98` ("nested report wakes it there") now expect the commander's place.
- `messaging-thread-routing.test.ts:20-32` (Nerd → Emberus) needs `reply:true`.
- `messaging-thread-routing.test.ts:56-63`: the owner's request delivered in a thread is posted in the thread unless asked.
- `commander-opening.integration.test.ts:20-46`: done/failed escalations stay in the thread; blocked/needs-decision keep their route.
- `commander-handover.integration.test.ts` R1: authority is unchanged, return place changes.
- `integration/approval-resume-routing.test.ts`: the reviewer's message needs `reply:true` to keep its current expectation.
- `agent-queue.integration.test.ts:136` ("private answer to the return address fixed at insertion").
- `messaging-s8-idle.test.ts:63` (brief revision replies to reviser).

Unchanged and still required: `corner-wake-answer-room.test.ts` and `scheduled-run-place.test.ts`.

## 7. Migration and rollout

- The schema adds `reply_to`, `reply_sent_id` and `reply_request_id`.
- One-time backfill for *pending* rows only, and **strict** (Astra #2). Only rows that carried a structural ask get `reply_to = COALESCE(message->'replyAddress', message->'route'->'from')` and `reply_request_id = id`:
  - `private_payload->'messageAsk' IS NOT NULL`, or
  - the text starts with `blocked:` / `needs-decision:`.

  Plain pending `message` rows and informational `reply` rows get none. Legacy orders need no backfill row: S3e derives at spend time, which also covers orders old images write after the backfill (Astra #3).
- `reply_sent_id` is set when `posted_reply_id` / `result_message_id` already holds a delivery.
- Pending `corner_objective`, lifecycle and continuation rows get no `reply_to`, which applies the owner's rule to them immediately.
- Rolling overlap (Astra #1 corrected my claim):
  - New readers ignore old-written return addresses, so those rows answer in the work place.
  - **An old image answering a new-written row still routes by `route.from`** (`message-route.ts:7-10`, `agent-command.ts:886-917`). It does that unasked, and without writing `reply_sent_id`, so a new image's resume of the same request can deliver again.
  - This is bounded to the Fly rolling-replace window, and it matches today's behaviour exactly, so it is no regression. It is accepted rather than engineered around.
  - The alternative is a two-release expand/contract: release N adds columns and spend readers, and release N+1 stops inheritance. That removes the window at the cost of a second release. It is offered as **D5**.
- `return_room_id` is dropped in the next contract release.

## 8. Decisions for the owner

- **D1**: plain `message()` defaults to `reply:false` (strict reading of "asked for one"). Recommended. The alternative treats every `message()` as an ask, which keeps today's agent ping-pong.
- **D2**: `open_thread` defaults to `reply:false`. Recommended. Commanders that need completion either set `reply:true` or rely on the existing `opened`/`merged` watch.
- **D3**: legacy `order` counts as an ask (S3e) until cutover deletes it. Recommended, because old helpers cannot pass `reply:true`.
- **D5 (rollout)**: one release, accepting a bounded old-image overlap that matches today's behaviour (recommended), or a two-release expand/contract with no overlap.
- **D6 (S5 block answers)**: once per ask or re-ask, with later answers coalesced or left visible (recommended, the literal rule). The alternative wakes the implementer for every human answer in an open block's chain, which is today's behaviour.
- **D4 (B1, outside the reply rule)**: who receives a `blocked:` when an agent opened the thread on a person's behalf. Firstmate's 24 Nov instruction settled the handover half: S8 sends blocks to the approved handover's commander session. Remaining question:
  - Option (a) is today's behaviour: the agent opener.
  - Option (b): the person whose message the opening cited (`corner_brief_revisions.approval_basis.sourceMessageId` author), with the agent copied.
  - The design does not change this; it needs the owner's call.

## 9. Objections and answers

Each objection is followed by my answer.

1. **"Once" loses the final result of multi-turn work.** The commander's one reply can be the implementer's first-turn progress (eng A4).
   *Answer:* that is the owner's rule as written. The remaining channels are explicit:
   - blocks, which are new asks,
   - a fresh `message()`, which is a new message, not a reply,
   - the `merged` watch,
   - and S4f, under which a local progress *post* never spends.

   Only the turn's closing text or `reply` spends. Tool text tells the implementer that its closing text is its one reply.
2. **Agents and stored procedures assume every message gets a reply (eng A5, Astra #13).** *Answer:* D1 is the owner's call. The prompt line "Reply goes to: …" and the tool text make the change visible. Old helpers degrade to the strict default, and asks and blocks still route.
3. **Old images keep routing during the rollout (Astra #1).** *Answer:* that is accepted as D5. The overlap only reproduces today's behaviour, bounded by the rolling window.
4. **The backfill grants or misses asks (Astra #2, #3).** *Answer:* the backfill is now strict, and legacy orders derive at spend time (§7).
5. **A self-opened thread blocks to itself (Astra #7).** *Answer:* the opening's `route.from` stays the commissioner (S6). Only the reply derivation is deleted.
6. **Handover doesn't move blocks (Astra #8).** *Answer:* correct, and pre-existing. Under Rule 2 (24 Nov), S8 resolves the commander through the approved handover.
15. **Owner, 24 Nov: commander-aimed traffic lands in the commander's thread session, which lacks its context.** *Answer:* adopted as Rule 2 and S8. §4c re-checks every flow for its receiving session, and four paths that already send to the wrong session today are deleted.
   - *Surviving risk:* a person can still deliberately tag the commander inside the thread, starting C@T. That is a person's explicit choice and is allowed (Rule 1).
16. **"Where the work happens" was hand-wavy (owner, 24 Nov).** *Answer:* replaced by the session definition and the I1–I3 zero-row queries in §2. The two-active-corners case is test 30.
   - *Refinement:* `message()` and `post(address)` carry the turn's `request_id` today, so the check needs `messages.turn_write` to separate output from deliberate sends.
7. **Two answers to one block (Astra #4).** *Answer:* once per ask, with coalescing and re-ask (S5, D6).
8. **`reply(id, ask)` and the ask-back chain (Astra #5, #6).** *Answer:* S4a now applies only when a request exists, and it carries `resumes_request_id`.
9. **Batch receipts, silence and the completion joins (Astra #9, #10, #16).** *Answer:* S4c, S4f and S4g, plus the reader list in §5.
10. **Person loses access to the result (Astra #11)**, when a thread is opened under a chat the commissioner can't read. *Answer:* not a routing defect. The commissioner got its one answer in P, and opening a thread its commissioner cannot read is an access question. It is listed in NOT in scope.
11. **`message(to: person, reply:true)` has no row to spend (Astra #12).** *Answer:* S7, the request lives on the message.
12. **Review findings reach the implementer a second time through `corner_review_needed` (Astra #15).** *Answer:* that wake is the corner machine's system handback about the PR head (`corner-lifecycle-review-state.ts:60-79`), not the reviewer's reply. It is same-place and already deduplicated by `reviewHandbackId`, so it is kept and the "once" claim is scoped to replies.
13. **An empty review final, or a harness failure, ends an asked request silently (Astra #14).** *Answer:*
   - An empty background final is a legitimate zero sends.
   - The harness-failure line posts in the work place and leaves the request unspent.
   - A person's retry inherits the request (S4d).
14. **Out of scope and pre-existing (Astra #18, #20).** A file-only answer stays owed when there is no text (`agent-command.ts:889-902`). Skipping a cross-room choice loses its continuation (`room-choice.ts:588-599`). Both reproduce on `main` today, are independent of routing, and are listed for follow-up.

## 10. Plan-eng-review (gstack `plan-eng-review`, run autonomously)

The review ran non-interactively: I'm an autonomous worker. Where an issue was mine to fix, the fix is folded into the spine. Choices that belong to the owner are listed as decisions in §8.

**Step 0, scope.**
- The design touches about 12 server files plus tool text. Most of the change is deletion of the derivation chain at `agent-command.ts:706-723`, which is the right size for a root-cause fix.
- Existing code that already solves part of the problem is reused:
  - `sendMessage` delivery,
  - `wakeBlockAnswer` for block answers,
  - `endAgentTurn` / `result_message_id` for completion,
  - the `posted_reply_id` idempotency.
- One new owner file, `reply-request.ts`, is created. Nothing else new.

### Architecture

| # | Sev | Conf | Finding | Resolution |
|---|---|---|---|---|
| A1 | P1 | 9 | Completion detection matches the posted answer by room (`agent-command.ts:816-817`: `posted.room_id=item.return_room_id`; `856-857`; `agent-command-route-agent-result.ts:58`). With `return_room_id=room_id`, a routed answer delivered elsewhere would look unanswered and be redelivered. | S4c: completion = `result_message_id`. |
| A2 | P1 | 8 | The ask-back pattern. A asks B with `reply:true`, and B answers with `ask`. Without S4a that ask spends the request and A never gets the verdict (`agent-command.ts:874-875` keeps follow-up asks distinct today). | S4a. |
| A3 | P1 | 8 | Unreachable `reply_to`. Today `queueMessage` throws `commander is no longer a member of the return address` (line 492), or the item is cancelled `return_address_archived` (lines 896-899). Under S4 the spend would commit before a failing delivery, or the answer would be lost. | S4b: savepoint, mark unreachable, post in the work place. |
| A4 | P2 | 8 | "Once" plus multi-turn work. If the implementer ends its first turn with progress text, that text is the one reply, and the commander never gets the result. | Accepted: it is the owner's rule. Mitigations: tool text ("your closing text is your one reply to the asker"), the `merged` watch, explicit blocks, and a fresh `message()` to the commander, which is a new message, not a reply. Surviving risk is carried to §9. |
| A5 | P2 | 7 | Behaviour change for agents. Procedures and memories written under "every message gets a reply" (`replyNeeded` is true for `message`, `packages/api-contract/src/agent-messaging.ts:56-61`) will wait for replies that never come once D1 = false. | The tool text, the `Reply goes to:` prompt line, and a one-time audit of stored procedures that rely on replies (`read(facet:procedure)`). The owner decides D1. |
| A6 | P2 | 7 | Today the commander's authority and the reply route share one source (`threadCommanderAddressSql` reads `message.replyAddress` / `route.from`, `corner-commander.ts:28-32`). Once `replyAddress` moves to `reply_to`, that SQL must keep reading `route.from` only, or the commander would silently move. | S6. The SQL stays on `route.from`; test 7 covers it. |

### Code quality

| # | Sev | Conf | Finding | Resolution |
|---|---|---|---|---|
| Q1 | P2 | 9 | Return-address logic lives in six places: `insertAgentCommand`, `recordedMessageRoute`, `legacyMessageRoute`, `commanderReportAddress`, `reportToCommander`, `cornerReportOpening`. | S4e: one writer and one spender, with an invariants.json sink. |
| Q2 | P2 | 9 | `agent-command.ts` is at 993 of 1,000 lines. | The new logic goes in `reply-request.ts`; the deletions (about 25 lines) give headroom. |
| Q3 | P3 | 8 | `report_address` and `escalation` remain for block statuses only. | They are named in the `messaging-cutover.ts` removal point. |

### Tests

```
CODE PATHS                                          USER FLOWS
insertAgentCommand                                  Ruby self-opened thread ........ T1 [→E2E]
 ├ explicit ask sets reply_to (S3a-e) ... T2,T8     Agent opens thread reply:true .. T8
 ├ no ask → reply_to NULL .............. T3,T14     Cross-chat review request ...... T2,T11
 └ continuation copy rule .............. T4,T5,T14  Block → commander → thread ..... T6
spendReplyRequest                                   Handover ....................... T7
 ├ unspent → deliver ................... T2        Approval resume ................ T4
 ├ spent → work place .................. T2,T10    Choice answer continuation ..... T5
 ├ ask answer → no spend ............... T11       Archived/removed asker ......... T12
 ├ unreachable → mark + work place ..... T12       Migration / rolling overlap .... T15,T16
 └ concurrent siblings ................. T9
completion by result_message_id ........ T13        Tool text behaviour ............ T18 [→EVAL]
sink invariant ......................... T17
```

All new paths map to tests 1–18 in §6, with no gaps left. The flipped tests in §6 are regressions of intended behaviour and get rewritten in the same change.

### Performance

No issues:
- The spend is one primary-key `UPDATE`.
- The `reply_request_id` lookup is by primary key.
- The backfill touches pending rows only.
- Removing the handover and parent subqueries from the hot `insertAgentCommand` query (the `cornerCommanderBriefSql` lateral is still needed for authority) has no cost.

### Failure modes

| Path | Realistic failure | Test | Handling | Visible |
|---|---|---|---|---|
| spend | Delivery throws after the spend | T12 | savepoint (S4b) | receipt + post |
| copy rule | A new continuation reason forgets `resume:true` → answer posts in place (no routed reply) | T14 | safe default (work place) | answer visible in place |
| migration | A pending objective loses its old return | T15 | intended | visible in thread |
| old helper | It reads `returnRoomId` for display only (`apps/body/src/place-prompt.ts:174`) | T16 | none needed | none |

No critical gaps. Every failure posts in the work place rather than going silent.

### NOT in scope

- **B1** block recipient for agent-opened threads (D4).
- **B2** background-wake noise.
- **Turn/status state bugs, missing wakes, stop, thread-boundary pushes, model/grant issues** (§1b). These are separate defects.
- **Dropping the `return_room_id` column.** That is the next contract release.

### What already exists

`sendMessage` (delivery), `wakeBlockAnswer` (block answers), `endAgentTurn` (completion), the `posted_reply_id` idempotency, the `messaging-cutover.ts` removal point, and the corner watches (`opened`/`merged`). All are reused, and nothing is rebuilt.

### Parallelization

Sequential implementation. Every step touches `apps/server/src` queue/answer code.

## 11. Astra adversarial pass

The pass ran `codex exec -m gpt-6.2-astra`, medium effort, read-only, on `main` `4f396c7d9`. Astra was given only the rule, the code and the draft design (the draft before §4b). Its verbatim output is in `astra-output.md`.

| # | Sev | Finding (short) | Verified | Disposition |
|---|---|---|---|---|
| 1 | P1 | Old image still routes by `route.from` during the rollout | yes (`message-route.ts:7-10`) | accepted overlap, D5 |
| 2 | P1 | The backfill grants asks to FYI messages and replies | yes | backfill made strict (§7) |
| 3 | P1 | The backfill misses legacy orders | yes (`agent-command.ts:758-763`) | S3e at spend time |
| 4 | P1 | One block answered twice wakes the implementer twice | yes (`implementer-blocks.ts:89`) | S5 once per ask, D6 |
| 5 | P1 | `reply(id, ask)` bypasses the sender's choice | yes | S4a scoped |
| 6 | P1 | The ask-back loses the verdict | yes | `resumes_request_id` |
| 7 | P1 | A self-opened thread blocks to itself | yes (`implementer-blocks.ts:54`) | S6: keep `corner-writes.ts:274-276` |
| 8 | P1 | Handover doesn't move blocks | yes, pre-existing (`corner-commander.ts:15-17`) | S8 (Rule 2) |
| 9 | P1 | Batch key merges requests | yes (`agent-command.ts:829`) | S4g |
| 10 | P1 | A progress post plus silence discharges an ask | yes (`operation-effects.ts:222-226`) | S4f |
| 11 | P1 | The commissioner can't read the thread | plausible | out of scope (access) |
| 12 | P1 | A person-asked request has no row | yes | S7 |
| 13 | P1 | Adapters drop the new flag | yes | §5 adapter list |
| 14 | P1 | Empty review final, harness failure, retry | yes | objection 13, S4d retry |
| 15 | P1 | Second findings path | yes | kept: system handback, objection 12 |
| 16 | P2 | `turnComplete` proof joins `return_room_id` | yes (`agent-messaging.ts:144-158`) | §5 readers |
| 17 | P2 | Deadlock; nested transaction is not a savepoint | yes (`database.ts:538-539`) | lock order + explicit SAVEPOINT |
| 18 | P2 | File-only answer stays owed | yes, pre-existing | out of scope |
| 19 | P2 | Agent-owned schedule loses its wake | yes (`agent-schedules.test.ts:71-97`) | S3f |
| 20 | P2 | Skipped cross-room choice | plausible, pre-existing | out of scope |
| — | — | Wrong claims: "no messages row" for routed replies; "ping-pong loop" | yes | both corrected (S4c, §1b) |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (owner decisions) | 11 issues, 0 critical gaps |
| Outside Voice | `codex exec gpt-6.2-astra` | Adversarial pass | 1 | issues_found → folded | 20 findings: 17 folded, 3 out of scope |

- **CROSS-MODEL:** the eng review and Astra agree on completion detection, the ask-back case and unreachable recipients. Only Astra caught the self-opened block, the handover, the batch key, silence, the deadlock and the rollout. All are folded except the rollout, which is D5.
- **VERDICT:** design ready for the owner's decisions. Implementation is blocked until D1, D2, D5 and D6 are answered (and D4 if B1 is to be fixed).

**UNRESOLVED DECISIONS:**
- D1 plain `message()` defaults to `reply:false`
- D2 `open_thread` defaults to `reply:false`
- D3 legacy `order` counts as an ask
- D4 block recipient for agent-opened threads (agent opener or commissioning person); the handover half is settled by S8
- D5 one release with a bounded overlap, or two-release expand/contract
- D6 block answers once per ask or re-ask
