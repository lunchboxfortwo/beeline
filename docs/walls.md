# Walls

A request enters its agent's queue, reaches the live session and receives an
answer at its recorded return address. Checks stay where their data is;
refusals use `wall(kind, reason)` from `@beeline/api-contract/daemon`.
`packages/api-contract/src/walls.ts` owns the kinds and error shape.
`packages/scripts/check-walls.mjs` rejects other refusals, gates, skips, waits and caps
on that path.
Production wall constructions: 4.
Any additional construction requires lunchboxfortwo's review of a change here.

## `signed-in` The person must be signed in

Why: each request must come from a known account.

## `membership` Only members of a chat can message its agents

Why: membership protects who may ask an agent and where its answer may go.

## `credentials` Each agent's credentials stay its own

Why: sessions, model use and answers must stay bound to their own identity and private state.

## `sandbox` The sandbox walls around the agent's session

Why: tools reach only permitted files and capabilities; if the sandbox fails, the agent still answers with writes restricted to its own folder.

## `stop` Stop

Why: a person can stop work; a harness that dies while answering publishes its recorded stopped-answer outcome.
