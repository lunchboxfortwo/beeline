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

- `apps/server/src/agent-command-create-agent-command.ts routeHumanMessage: early return if (!source) return false;`

## `membership` Only members of a chat can message its agents

Why: membership is the one rule for who may ask an agent and where its answer may go.

- `apps/server/src/agent-command.ts insertAgentCommand: early return if (!member.rowCount) return undefined;`

- `apps/server/src/agent-command-create-agent-command.ts routeHumanMessage: skip if (!agent) continue;`
- `apps/server/src/daemon/execute.ts daemonExecute: refuse throw sourceError;`
- `apps/server/src/daemon/execute.ts daemonExecute: refuse throw error;`
- `apps/server/src/daemon/execute.ts daemonExecute: refuse if ('delivered' in reported && reported.delivered === false) throw new CommandRefusalError('commander is no longer a member of the return address', 403);`
- `apps/server/src/daemon/messages.ts daemonPostRoomMessage: refuse if (!result || result.outcome === 'write_failed') throw new Error('command output authority rejected');`
- `apps/server/src/daemon/messages.ts daemonPostRoomMessage: refuse if (result.outcome === 'authority_rejected') throw new Error('command output authority rejected');`
- `apps/server/src/daemon/messages.ts daemonPostRoomMessage: refuse if (!result.row) throw new Error('command output authority rejected');`

## `credentials` Each agent's credentials stay its own

Why: an agent answers only with its own logins, keys and hosted-model allowance, never another's.

- `apps/server/src/agent-command-route-agent-result.ts authorizeCommandOutput: refuse if (!row) throw new Error('command output authority rejected: no command row');`

- `apps/server/src/daemon/execute.ts daemonExecute: refuse if (typeof candidate.agentId === 'string' && candidate.agentId !== authenticatedAgentId) throw new Error('daemon token does not own requested agent');`
- `apps/server/src/daemon/execute.ts daemonExecute: refuse if (walletCall && !scopedRoom) throw new Error('wallet access requires an active Room command');`

## `sandbox` The sandbox walls around the agent's session

Why: the agent's tools reach only what its session may touch; if the sandbox cannot start, the session still runs with writes refused outside its own folder, is told so, and answers.

## `stop` Stop

Why: a person can end a request; a stopped item is not answered.

- `apps/server/src/agent-command-route-agent-result.ts authorizeCommandOutput: refuse if (row.state === 'cancelled') throw new Error('command turn cancelled');`

- `apps/server/src/daemon/messages.ts daemonPostRoomMessage: refuse if (result.outcome === 'turn_cancelled') throw new Error('command turn cancelled');`
