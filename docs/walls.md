# Walls

A message for an agent goes into that agent's queue, the helper hands it to the
agent's live session, and the answer is posted to the item's return address.
Only the walls below may refuse, drop, skip or hold a message on that path.
`scripts/check-walls.mjs` (run in TYPECHECK) fails any change that adds a
refusal, early return, skip, wait, lease or cap to the path functions it names
unless the exact site is listed here under its wall. lunchboxfortwo reviews
every change to this file.

## `signed-in` The person must be signed in

Why: a message has to come from a known account before any agent sees it.

## `membership` Only members of a chat can message its agents

Why: membership is the one rule for who may ask an agent and where its answer may go.

## `credentials` Each agent's credentials stay its own

Why: an agent answers only with its own logins, keys and hosted-model allowance, never another's.

## `sandbox` The sandbox walls around the agent's session

Why: the agent's tools reach only what its session may touch; if the sandbox cannot start, the session still runs with writes refused outside its own folder, is told so, and answers.

## `stop` Stop

Why: a person can end a request; a stopped item is not answered.

- `apps/body/src/agent-runner.ts post: early return if (error instanceof DaemonApiError && !error.retryable) return;`
