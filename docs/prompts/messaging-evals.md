# Messaging evaluations

Layer A runs in the normal server Vitest suite. Its assertions name the complete
set of woken `(agent, place)` tuples, including empty sets for server merges.
Layer B uses the existing saved-case format and subscription-only Codex replay.
Actions runs deterministic case validation and layer A. An assigned subscribed
agent runs layer B on squire and posts its table on the exact open PR head.

Run the messaging catalog with one command after setting `PR_NUMBER` and an
output directory outside the checkout:

```sh
node --import tsx scripts/prompt-pr-replay.mjs --repository Beeline-Work/beeline --number "$PR_NUMBER" --head "$(git rev-parse HEAD)" --only messaging- --out "$TASK_PROOF/prompt-replay"
```

Omit `--only messaging-` to replay the entire saved library. The runner stamps
the small-model pin `gpt-6-luna` and large-model pin `gpt-6.1-sol`. Each case runs
three fresh samples on each model; all three must pass. A failed assertion stays
failed. The table names the failing sample and assertion. Grading reads actual
tool calls and arguments, with plain text checks where needed; no model grades
another model. The simulator never executes its proposed operations.

Use the installed Codex CLI's ChatGPT subscription. No API key, Actions secret,
runner provisioning, nightly restart, retry, backoff, or admission control is
part of this evaluation.

Before a release, layer C runs on the isolated proof rig: a person DMs Ruby;
Ruby messages Jellybean from a chat; Jellybean opens a thread and pushes; the
server requests review in that thread; Sol approves; the server merges. Record
each wake's `(agent, place)` tuple outside the checkout and compare the complete
sequence with the expected one. The run must preserve chat origins separately
from thread destinations. It does not authorize running a production daemon
from a developer worktree.

The queued legacy protocol has one removal point, `messaging-cutover.ts`.
Remove its adapter and the legacy daemon operation routes together after old
queued and in-flight work has drained. No legacy tool alias is advertised.
