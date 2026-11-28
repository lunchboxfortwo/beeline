# Codex prompt delivery

Beeline supplies session rules when it creates an ACP conversation. When the
harness advertises structured `systemPrompt` support, the first user prompt
uses the rules already supplied by `session/new`. Claude and Pi keep their
adapter-specific system instructions. Other adapters receive a fallback copy
in the first successful prompt of each fresh conversation.

In `PlaceSession`, successful prompts let later turns reuse the rules already
in the conversation. For Codex ACP versions `2.3.0` and `2.10.0` with
structured system prompts, ACP compaction notifications invalidate that
delivery state, including during an active prompt. The next prompt restores the
rules. The installed `2.10.0` adapter stores the append text as developer
instructions and includes compaction notifications when the client advertises
`session.compaction`. A failed or cancelled prompt also clears the tracked
delivery state.

The Codex cache begins empty after a native load, so the first prompt after
load restores the rules. Other adapters without tracked compaction signals
reuse their first successful delivery for the lifetime of the live session.
Beeline has no signal to restore fallback rules after silent compaction in
that session. Starting a new conversation restores its startup delivery. The
Cursor bridge starts a new CLI invocation per turn and supplies the stored
rules to each invocation.

`PlaceSession` tracks the session rules alone. The proof below records the
earlier rollout that also tracked members, memory, corners, objective,
generated title, brief, checkout, and available apps.

## Reproduced

Not a defect report: this is the approved prompt-cost optimization.

Proof `CODEX-ONCE`: create a real Codex ACP conversation with Beeline's assembled
session instructions, then deliver a first task, unchanged warm task, and a task
with one changed memory block. Before the change, the same instructions, members,
memory and corners appear in every turn. The before arm calls the unfiltered
assembler; the after arm uses the production ACP delivery cache. Both use the
same inherited Codex configuration, default model, native harness and fixture.
There is no Codex settings rewrite or tool-surface restriction.

The fixture uses a disposable cwd, one owner, and stable example corners. It is
a real model/session proof of the affected ACP path, not a production daemon
restart or a comparison against Ruby's original roster. The referenced owner-DM
measurement was inaccessible from this corner (message access denied).

## Demonstrated

Run from the repository root using the current agent's own inherited login:

```sh
BEELINE_CODEX_PROOF_OUTPUT=/tmp/codex-proof-prompts.jsonl \
  npm run prove:codex-prompt-delivery -w @beeline/body
```

The optional output file contains only generated fixture prompts, for structural
token counting. The script prints actual model input/cache usage from its own
session journal and ACP; it asserts the correct retained proof word on unchanged
turns and a new word after the memory update. It also requests real `/compact`,
requires the adapter's compaction notification, asserts full block restoration,
and checks the model still answers with the updated word.

Measured on squire on October 30, 2026 with Codex ACP (`2.3.0`). Session
rules contain (1,225) structural tokens in both arms.

| Turn | Before Beeline tokens | After Beeline tokens | Before model input | After model input |
| --- | ---: | ---: | ---: | ---: |
| first | (1,685) | (460) | (17,416) | (16,191) |
| warm | (1,685) | (19) | (22,293) | (19,402) |
| changed | (1,685) | (32) | (23,990) | (19,446) |

After real compaction, all blocks returned (1,685 structural tokens),
and Codex answered `COBALT` with reported input (19,378) tokens.
The unchanged warm payload contains only the task; the changed warm payload
contains memory and task. The first-turn totals including session rules are
(2,910) before and (1,685) after.

The measured rows are retained in [the proof record](codex-prompt-delivery-proof.json).

Input tokens include retained conversation and native Codex overhead; they are
not just the newly appended Beeline text. Cache-hit counts vary between runs.
Structural counts use `o200k_base` over the exact emitted Beeline strings and
count the session rules once at startup. They are a payload measure, not a billing
claim. No latency claim is made by this proof.

## Regression checks

`codex-prompt-delivery.test.ts` covers full cache misses, first-turn rules delivered
once, unchanged warm turns, one changed block, failed delivery, compaction during
a prompt, and empty-block removal. `acp-codex-delivery.test.ts` exercises the real
stdio client against a controlled adapter: negotiated compaction, actual prompt
wire text, native load cache misses, failed resume fallback, and unknown-version
full delivery. Existing Room/corner retention, native resume, ACP, prompt assembly,
and prompt-layer tests cover unchanged lifecycle and transcript behavior.
