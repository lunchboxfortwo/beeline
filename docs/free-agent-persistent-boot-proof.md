# Persistent free-agent boot recovery

Historical reproduction `free-agent-persistent-boot`, October 22, 2026.
The installer/watchdog paths described in that observation are retired. Current
images run the image-owned helper directly; use the current regressions below.

## Before the fix

An isolated script imported the checkout's built `runtime.js`, wrote its own
live PID and matching process start ticks into a temporary runtime's owner
record, and called `runtimeDaemonPid`. The process was not a Beeline daemon,
but the lookup returned its PID. This reproduces a legacy persisted record
whose PID and ticks collide after reboot. The affected user's machine was
not changed, and the precise identity of its reused PID remains unverified.

The entrypoint also started any installed launcher without checking the
published release first. Its prior regression explicitly required no download
for an installed helper.

## Disposable Fly proof

Created test Machine `805321f6220728` in `beeline-free-agents`, using the same
production image digest `fc5e3236992b1ff2a362801042f1ed8a56bf50cd7c68d001748ffe38d97654bb`,
with persistent rootfs and restart policy `no`. No production agent identity,
bootstrap token or server connection was provisioned.

Injected the changed entrypoint, bundled runtime owner validation and a small
launcher fixture into the test machine. The installer fixture replaces an old
launcher with a Node script that exercises owner validation and records
readiness. The old launcher writes a failure marker if executed, and the
replacement asserts that marker is absent. This substitutes for the public installer and a connected agent;
the shell entrypoint, owner validation, persistent disk and Fly stop/start are
real. Full helper bundle and image construction were checked separately.

First boot recorded boot ID `9f9cf741-5574-48d3-80e1-2c3fe4f5ea7e` and confirmed
refresh before launcher execution. The running fixture left an old launcher
on disk and saved its birth identity. Stopped the Machine through the Fly API,
waited for `stopped`, then started it again without changing its configuration.

Second boot recorded boot ID `adc35cdc-fc11-45ad-be3d-56812a065e06`, read the
previous boot's saved identity and confirmed:

- The persisted old launcher was replaced before execution.
- A saved owner with the previous boot ID, current live PID and current start
  ticks was rejected.
- A legacy tick-only owner record matching the unrelated live process was
  rejected.
- The launcher reached readiness.

The second boot returned `staleOwnerRejected: true` and
`refreshedBeforeLaunch: true`. Destroyed the disposable Machine after reading
the result; the API confirmed deletion.

## Current regressions

- `node --test infra/free-agent/entrypoint.test.mjs` checks image-owned selection
  despite a stale HOME launcher, exit propagation and hosted-service startup.
- `infra/free-agent/cold-start-proof.mjs` runs the built image and Pi against an
  isolated database and two server processes, through cold stop/start, image
  replacement while stopped and concurrent command/release signals. Docker is
  the default Machines stand-in; `PROOF_FLY_APP` selects a separate disposable
  app and reads its scoped token from stdin. A deterministic model is explicitly
  a stand-in for the external provider.
- `free-agent-acquisition.test.ts` and `free-agent-ownership.postgres.test.ts`
  cover credentials, removal and ownership handoff. Free-agent staging uses the
  shared atomic private-file writer, including fsync, so its model environment
  is durable before the first suspension.

## Legacy Pi environment upgrade

Reproduction `free-agent-legacy-model-env`, October 22, 2026. Before the fix,
calling the built environment reader with the allowlist emitted by release
`6d908054` omitted `BEELINE_FREE_AGENT_MODEL_TOKEN` from the child environment.
The existing Pi boot path returned before reconciling that persisted file.

Created disposable Fly Machine `84ee330a422398` on the existing free-agent image,
with persistent rootfs and a private test server/database. Seeded a Pi runtime
and its environment using the exact `freeAgentModelEnv` serializer extracted
from `6d908054`. The test server issued its own revocable bootstrap, daemon
and model grants. Current staging code created the runtime; the old helper
binary itself was not executed. No production identity or user's Machine was
used.

Before the cold stop/start, the runtime was already Pi, the legacy allowlist was
present, the canonical allowlist was absent, and the boot ID was
`dff04f5e-3192-40dc-9910-d1ebed355eae`. After stop/start, the changed entrypoint
installed the candidate helper through the real recovery installer and verified
bundle download. The boot ID became `825edba8-7879-4ac0-b601-a04c7f977b4a`, the
canonical allowlist was present, and the legacy one was absent.

The actual Pi/ACP runtime then claimed queued user work, authenticated through
the real server's free-agent model proxy, made one upstream model request and
published `UPGRADE_ENV_PROOF_OK` to the Room. The committed reply ID was
`c2747695800aa519a8a7e0b187f9370e5990399c482379956508ceda63b536b3`.
A deterministic local streaming model substituted for the external provider;
Fly, the cold reboot, installer, helper, Pi, command claim, token checks and
transcript publication were real. The candidate archive SHA-256 was
`e429685c643629e94a716e95ed8b55c04955abaeba8346599a3805df3be7b87c`.

The first preparation attempt hit a proof-harness deadline while fixing seed
startup dependencies; a fresh queued mention after the cold restart produced
the passing result above. Destroyed the Fly Machine and stopped the disposable
server, tunnels and database afterward. The regression test also spawns a real
child process, sends an authenticated HTTP model request after Pi boot migration,
and checks migration idempotence and retention of explicitly configured values.
