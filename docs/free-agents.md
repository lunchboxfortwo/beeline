# Free starter agents

Every newly created Workspace gets a free starter team, Beebee and Luna, owned
by its creator, when the owner has room for both under the free-agent limit.
Otherwise #general explains where the existing starter agents live and why a
new team was not created.
Existing Workspaces and the operator single-agent addition keep their existing
behavior. Each agent runs on its own small Fly Machine in the `beeline-free-agents` app, which sleeps when
its work finishes. People who only join an existing Workspace by invite get
none. Code: `apps/server/src/free-agents.ts`, `free-agent-model-proxy.ts`,
`fly-machines.ts`; helper `apps/body/src/free-agent-vm.ts`;
image `infra/free-agent/`.

New starter teammates are named **Beebee** and **Luna**, using `@beebee` and
`@luna` with the existing numeric suffix rule when a handle is taken. They keep their seeded face and
soul. Existing free agents keep their names.

## Lifecycle

- **Creation.** `PhoneService.createWorkspace` calls `createFreeAgentInWorkspace` in
  the same transaction as `ensureFirstRoom`. That call writes the identity, the agent
  row (harness `pi`, model `beeline/<model>`), the Workspace and `#general`
  memberships, the identity keys sealed with `BEELINE_FREE_AGENT_SEAL_KEY`, a reachable
  presence row and the exact server-authored `FREE_AGENT_HELLO` message in #general.
  New-workspace creation provisions the pair atomically and queues a durable
  starter onboarding run. After commit, `StarterOnboardingService` generates
  Beebee/Luna/Beebee banter through the shared model proxy using each agent's
  stored model and instructions. The phone supplies its timezone at creation.
  Room entry starts playback: each accepted line follows a brief working state,
  then Beebee posts the fixed first-name hello and asks “What should we work on?”
  Nothing follows that open question. Invalid or late banter falls back
  to this same hello. No option card or video workflow is created. Tic-tac-toe is
  available through the onboarding game tool when requested. Manual reruns queue
  the same flow after commit and remain outside signup funnel counts. The
  single-agent operator path retains the legacy hello.
  The legacy hello teaches Room replies, corners and connectors, then asks what the person is working on. It contains no repository card; the agent offers one only for coding or GitHub-connection intent.
  The hello tags the owner through the normal mention/push path and uses the
  agent's actual handle. It creates no model turn or Machine. The first real
  queued work provisions the Machine through `FreeAgentService.kick` from its committed work event.
  A creator owns at most
  `BEELINE_FREE_AGENT_MAX_PER_OWNER` (default 3) free agents.
- **First boot.** The pinned image contains its compatible helper and Pi. The
  entrypoint launches that baked helper once; it performs no installer download,
  refresh loop or startup watchdog. Bootstrap exchanges the Machine's saved
  bootstrap identity for keys, daemon access and a model token. Files and account
  binding persist on the root filesystem. A lost create reply is reconciled by
  stable agent identity and adopts the existing Machine without replacing files
  or rotating its bootstrap identity.
- **Sleep.** Authenticated helper connections, committed command updates and
  connector reports admit a sleep check through `FreeAgentService.subscribeToWakes`.
  The server refuses while any command is pending or claimed, or a connector
  install/sign-in is active. Completion, failure or disconnect releases that
  protection on its own committed event. Suspension completion reads pending commands and connector work together so work committed during the snapshot resumes immediately. Otherwise the server records
  `sleeping` and asks Fly to suspend the Machine. Suspend failures are reported
  without falling back to a cold stop. A helper behind the announced release
  asks for `refresh`: the server boots it on the configured image immediately,
  so the pinned image/helper is ready before the next message. The refreshed helper connects
  and its connection event admits suspension once no work remains. Image promotion runs
  `--refresh-free-agents` to warm existing stopped or outdated sleeping Machines;
  active helpers reconcile the image when their work finishes. There is no idle
  countdown, polling, periodic sweep or timed retry. The legacy helper sleep
  endpoint remains available. Confirmed Fly suspension checks for work that
  arrived during the snapshot and admits one resume, including a command already
  claimed by the still-serving helper. Removal and command cancellation remain authoritative.
  The helper never updates in place.
- **Wake.** The Fly adapter submits one start request per admitted action. HTTP 412 and lost replies return to the owner without a timer or resubmission (`fly-machines.test.ts`). Before starting an existing Machine, the server compares its image
  with the configured published digest and updates it while keeping its complete
  configuration and persistent rootfs.
  Every committed `agent_commands` INSERT for a free agent calls
  `FreeAgentService.wake`. A committed connector-assignment notification also
  wakes a free agent with active connector installation or sign-in work, independently of model-spend admission. There is no leader sweep, retry deadline,
  idle reaper or retention deletion. A failed provider call waits for another
  actual request. Wakes are never
  suppressed for an offline Machine (`agentMachineOfflineSql` exempts free agents). A
  released connection keeps presence `online`, `held`, `asleep`, so mentions never get
  "its helper is offline". `LiveLink` owns the machine socket; an actual socket
  close admits reconnection.
  For every agent, dispatch also writes a working turn before helper pickup.
  A helper claim replaces the reserved `pending:<command id>` generation in
  that same row. Claimed work belongs to its connection until it reports a result.
  A disconnect returns unfinished commands to pending without a failure notice.
  The next connection claims them again; no pickup or silence timer ends a turn.
  Delayed wakes paint when released; passive computer observations stay silent.
- **Removal.** The existing Members remove action admits the agent owner or a
  Workspace owner/admin. Removal from any Workspace retires the free-agent runtime,
  matching the existing global daemon retirement. Its transaction keeps a permanent `removed_at` tombstone,
  revokes model/bootstrap and daemon access, and records `removed`. After commit,
  cleanup deletes the Fly Machine without delaying the removal. A later committed source or real recovery can revisit
  failed deletion, including a Machine created by provisioning already in flight.
  Removed agents cannot bootstrap, wake, reap back into service, or be replaced by
  `--add-free-agent` in that Workspace. Beebee's server-posted first hello ends by explaining how
  to remove it from Members.
- **Existing Workspaces.** An operator gives one its free agent with
  `node apps/server/dist/index.js --add-free-agent <workspaceId>` on a server Machine.
  The agent posts the same hello once and boots only for real work. It goes to
  the oldest owner and to `#general`, or to the oldest public
  top-level Room when there is no `#general`.
- **Membership events.** From creation, each free agent's `#general` membership
  carries `event_subscriptions` `joined` and `left`. A join is the existing `joined`
  event. A Room leave or removal already writes a `member-left` or `member-removed`
  line, and `wakeFreeAgentsForLeaves` (run by the leader on every committed message)
  queues one wake on it. No System message producer changed. Leaving the Workspace
  stays silent, as Beeline already decides. An agent joining still wakes the free
  agent, and its instructions say never to greet an agent. The instructions pin the
  owner's exact join greeting (`FREE_AGENT_JOIN_GREETING`, after the joiners'
  @handles) and the exit note (`FREE_AGENT_EXIT_NOTE`). Greetings and notes spend the
  owner's allowance like any turn. Several events while the Machine sleeps are
  coalesced on return into one turn.

Every transition writes `free_agent_events`. These rows are the source of the
rewake latency numbers from `scripts/prove-free-agent.mjs`: created, provisioned,
bootstrapped, connected, sleep_requested, slept, wake_requested, machine_started,
reaped_idle, deleted_idle and allowance_reached.

Existing free agents switch to Pi on their next cold boot. The helper upgrades
the persisted runtime and writes a private Pi provider configuration before
starting sessions. Every boot also reconciles the persisted model environment,
including runtimes already using Pi: legacy `BUZZY_*` names and passthrough
entries become `BEELINE_*`, the scoped model token stays available to the child,
and replacement is atomic. The environment reader accepts the legacy allowlist
spelling until migration completes. The image supplies Pi and pi-acp; the helper reports a missing program instead
of downloading a replacement. Prior OpenCode harness session history does not carry over;
Workspace messages remain available. Pi and pi-acp state directories are covered
by the existing sandbox binds. The provider pins a 1,000,000-token context window
and a 65,536-token output ceiling.

## Model access and allowances

The Machine never holds a provider key. Pi's `beeline` provider points at
`POST /v1/free-agents/model/chat/completions` with the current claimed invocation’s private credential. The release-owned Pi extension supplies invocation and request-ID headers to the existing native provider transport and commits its signed response receipt; legacy agent-wide model tokens cannot call this endpoint. The
proxy pins each new agent's stored model. Beebee uses `BEELINE_FREE_AGENT_MODEL` (default `deepseek/deepseek-v4.1-flash-1017`); Luna uses `BEELINE_FREE_AGENT_LUNA_MODEL` (default `openai/gpt-6-luna`). Existing rows without a stored model keep the configured legacy model. Both teammates reserve and settle against the same owner's allowance and shared dollar budget. It
forwards to `BEELINE_FREE_AGENT_MODEL_UPSTREAM` (default OpenRouter) with
`BEELINE_FREE_AGENT_MODEL_KEY`, which may be a Squire egress grant. Before each call it
reserves an estimated prompt plus a capped reply against the
owner's daily allowance with atomic counter updates. Concurrent reservations
fit the cap, and each reply is bounded to the estimated room left. Actual
usage can exceed the prompt estimate; settlement corrects the balance. On completion it settles to the reported usage.
A refused call is
refunded. An uncertain helper request retains its reservation until an authoritative result can settle it; reported usage is charged. The default allowance is 3M tokens a day, and an owner's first 24 hours (from their first settled model call) get a larger 10M-token allowance so day one does not run out. There is no lifetime cap unless
`BEELINE_FREE_AGENT_LIFETIME_TOKENS` is
set. The first-24h allowance is `BEELINE_FREE_AGENT_FIRST_DAY_TOKENS` (default 10M,
never below the daily cap). A charge
counts uncached prompt tokens plus completion tokens plus `ceil(cached × weight)`.
The cached weight defaults to 0.25 (configurable within 0.10–0.25).
At the cap the proxy answers, in the agent's voice, that the allowance is used
and how to connect the person's own agent.

The proxy caps every reply at `BEELINE_FREE_AGENT_MAX_OUTPUT_TOKENS` (default
32,768). It sends upstream the smallest of this cap, the harness's own
`max_tokens`, and the allowance and budget room. A request with no bound
reserves 8,192. Pi still asks for 65,536, so the cap changes with a server
restart and needs no image rebuild.

Each authorized model call goes directly upstream. A provider refusal is recorded
for that exact invocation and returned plainly. The server leaf reads its recorded
receipt after provider transport loss; a lost helper response remains UNKNOWN,
without a helper-side receipt request or another paid request. No process-wide call queue or per-owner
minute throttle delays a call. Allowance and dollar reservations still happen
atomically before provider entry.

Helper model calls require a claimed `input`/`resume` command and its current
connection owner. Every request checks current invocation authority and the shared cost
budget; a refusal ends that turn through the single terminal owner. The Machine
then sleeps at its normal idle boundary. Pending and completed commands do not
permit calls, including copied model tokens used from outside Beeline. The
helper retains the command claim through model responses and tool follow-ups;
there is no post-completion grace that would authorize idle calls. Server-owned starter banter is a separate internal entry: a recent generating onboarding run must bind the agent and owner to the current Room team. It shares the same allowance, dollar budget, settlement code; the HTTP endpoint retains its live-turn requirement.

Reservations update owner lifetime accounting, daily tokens and shared dollars
in that order within one short database transaction, refunding excess owner
allocation when the shared budget grants less output. The legacy counter table
retains lifetime totals only; its minute and call-count fields no longer admit or
throttle requests. No network runs in that transaction. See `free-agent-accounting.ts`.
The shared UTC daily dollar budget defaults to **$25**. Each call reserves
its full uncached prompt and bounded output at configured fallback prices before
contacting the model. Successful calls settle to OpenRouter `usage.cost`, or to
configured input/output prices when cost is absent. Definite provider refusals refund
the reservation; unknown or interrupted outcomes without usage keep it. Each settlement
records `model_usage` (day, charged tokens, USD). A `budget_reached` event records
refused model calls. At the budget, model calls refuse with the allowance reason and end the
current turn once; provisioning and waking remain independent of model spend. A fresh request
gets a fresh cost check without parking or rearming old commands. Operators must keep fallback prices at or above their pinned
model's worst-case prices; changing models requires checking these prices.

Admission estimates tokenized text as `ceil(UTF-8 bytes / 3) + 256`, including
schemas and selectors. OpenRouter `reasoning.text`/`reasoning.summary` fragments
are concatenated for this calculation: thousands of repeated transport envelopes
are not model text. The original request is forwarded unchanged. Unknown detail
types/extra fields count in full. Image parts are accepted only when OpenRouter advertises image input for the
server-pinned model. Pi refreshes that same advertised input list on boot,
including persisted runtimes. Images reserve 131,072 input tokens apiece,
settled to reported usage. Binary data embedded in text and other non-text
content parts remain refused. Limits, cache behavior and the built-handler
photo demonstration: [free-agent image proof](free-agent-images-proof.md).

A matching recent prefix may use the server's own previously reported cache
reads at `cachedTokenWeight` (default 0.25). Evidence stores only hashes, counts
and time; changed model, upstream, tools or history and five-minute expiry start
cold. A process restart or routing to another server also starts cold. Caller
cache hints are not trusted.

The estimated reservation cannot fall below a cold text-byte ceiling plus
256 framing tokens minus **32,768 tokens shared across all outstanding requests
for one owner and UTC day**. `free_agent_usage.reservation_credit` tracks that
uncertainty through the same atomic daily counter update, across server
instances. Settlement/refunds release the credit and use exact reported usage,
including cache misses. This bounds admission uncertainty for the supported
text representation even when every cache prediction misses; it is not a
claim to know a missing provider usage record. A crashed request can leave its
reservation/credit held conservatively, as with the existing token reservation.
The shared dollar budget retains its original full wire-byte reservation;
binary/metadata accounting never creates a dollar-budget bypass. The 8 MiB
request ceiling and spend accounting remain in force.
See [SUB0ZERO admission and instruction replay proof](free-agent-token-admission-proof.md).

Free-agent turns end on their result, explicit Stop, removal, or actual process loss.
There is no elapsed execution window, generated shell-time budget, model-call
queue or per-owner calls-per-minute limit. Model calls retain current command,
generation, connection and Room membership checks, the daily token allowance,
and the shared daily dollar budget. Lost model responses retain their original
invocation receipt; they do not authorize another paid request.

Runtime preparation is outside execution. The pending-command Room DTO carries
server-owned starting, release-download, preparation, reconnect and saved-message
failure phases in the existing thinking line, without an elapsed counter. Claims
start execution from the server claim timestamp. A pinned image runs its baked
helper without a boot-time installer or refresh loop. After updating a stopped
or suspended Machine, the acquisition owner waits for the returned version to
reach `stopped`, then sends one ordinary start. Running Machines own their update
restart. A lost result gets one fresh connection and authoritative Machine
read. Listener bootstrap/reconnect and release changes read pending desired work,
including stale waking rows. Automatic idle suspension and shared CPU remain.
Acquisition keeps a helper with a current live connection `running`; preparation
must not demote it to `waking` and revoke its claimed model access. The registration
and catch-up regression is in `free-agent-acquisition.test.ts`.

At 80% of whichever allowance applies (2.4M of the default 3M daily cap, or 8M of the 10M first-day cap), settlement posts one plain allowance notice per owner per UTC day into the room where the person is working, with the midnight UTC reset and a Members ->
Add agent link. The owner must be a room member; otherwise nothing is posted. Delivery does not call a model. The warning records
`allowance_warning` and `nudge_shown`; pairing a non-free agent in the same
Workspace within 24 hours records `agent_connected_after_nudge` once per agent.
Reaching the Add agent command within 24 hours of a warning records `guide_started`
once per warning. This measures that concrete setup step, not conversational acceptance.
Model-authored nudges are not reliably observable server-side and are not counted.
Instructions limit unsolicited
offers to inaccessible work or the warning, once per UTC day, and guide people
through running their own CLI without requesting or posting pairing codes.
Existing free-agent souls receive the guide during data migration.

## Server configuration

Free agents run when all of these are set:
`BEELINE_FREE_AGENT_SEAL_KEY`, `FLY_FREE_AGENT_IMAGE`, `FLY_FREE_AGENT_API_TOKEN`
(scoped to the app), and for the model `BEELINE_FREE_AGENT_MODEL_KEY`. Optional:
`FLY_FREE_AGENT_APP`, `FLY_FREE_AGENT_REGION`, `FLY_FREE_AGENT_CPUS`,
`FLY_FREE_AGENT_MEMORY_MB` (1 shared CPU, 2048 MB: with 1024 MB a Machine with no swap stalled after its first turn),
`BEELINE_FREE_AGENT_IDLE_SECONDS`, `BEELINE_FREE_AGENT_REAP_IDLE_SECONDS`,
`BEELINE_FREE_AGENT_DELETE_AFTER_DAYS`, `BEELINE_FREE_AGENT_DAILY_TOKENS`,
`BEELINE_FREE_AGENT_LIFETIME_TOKENS`,
`BEELINE_FREE_AGENT_CACHED_TOKEN_WEIGHT` (0.25),
`BEELINE_FREE_AGENT_DAILY_BUDGET_USD` (25),
`BEELINE_FREE_AGENT_INPUT_USD_PER_MILLION` (1),
`BEELINE_FREE_AGENT_OUTPUT_USD_PER_MILLION` (5),
`BEELINE_FREE_AGENT_MAX_OUTPUT_TOKENS` (32768),
`FLY_FREE_AGENT_API_ORIGIN` (proofs only). Fly offers no egress firewall for
Machines, so outbound traffic is not restricted. The abuse limits are Machine
size, automatic sleep, current invocation authority, owner token allowances and the shared dollar budget.

## Image and proofs

Hosted VMs contain agent-browser 0.41.2 (Apache-2.0) and Lightpanda 1.0.3
(AGPL-3.0), resolved from the latest stable upstream releases and pinned by SHA-256
in `infra/free-agent/Dockerfile`. Update the version and checksum together when
adopting a newer release; builds never resolve a mutable latest tag. The native
agent-browser CLI launches Lightpanda on demand. `free-agent-vm.ts` reconciles its
engine and executable environment into new and persisted isolated agent homes.
The browser socket directory is `/tmp/beeline-browser` inside each Room sandbox’s
private `/tmp`, keeping Unix socket paths below the limit despite long harness homes.
There is no Chrome, virtual display, Squire package, broker or startup service.
A bot check, sign-in or signup ends browsing with a plain explanation and the
suggestion to open the site personally or connect an owned agent. Do not retry
or claim a blocked action succeeded. Server connector routes refuse Squire
cards and assignments on free agents. Personal agents retain their own tools.

Every free agent receives exactly this team guide, including existing agents on
configuration reads: “Try to include another agent, if available, to request
feedback on your work as much as possible.” `FREE_AGENT_TEAM_GUIDE` contains no
question-count decay or additional directions. Personal agents do not receive it.

The server release leg (`.github/actions/server-leg/action.yml`) builds
`infra/free-agent/Dockerfile` from the release checkout, publishes its immutable
digest, and stages that digest as `FLY_FREE_AGENT_IMAGE` before the release's
existing server rollout. Each server receives it during that rollout; no
post-release job restarts server Machines. Publication failure stops the leg
before deployment. After rollout, the leg verifies the setting on each server
and refreshes every eligible sleeping Machine. Fly exec uses the absolute
`/app/apps/server/dist/index.js` entrypoint and checks the JSON remote exit code;
flyctl's local exit status does not reflect remote command failure. The refresh
logs selected, started, unchanged and failed counts. A fully shipped rerun skips
image publication and server updates but still verifies and refreshes helpers,
so a partial refresh failure cannot be hidden by an already-shipped server.
`free-agent-refresh.test.ts` covers 32 sleepers, exclusion fences, partial
failure, connection-driven suspension and subsequent warm wake.
`scripts/build-free-agent-image.sh` builds the
same image by hand.
`npm run prove:free-agent:docker-machines` stands in for the Machines API with
Docker for a local end-to-end run (suspend = `docker pause`). `npm run
prove:free-agent` runs the end-to-end proof and the rewake latency measurement
against any server whose database it can read.

For three real-Fly first boots and three suspend resumes with a ten-step
mention-to-reply timeline, use the [timeline proof](beebee-first-reply-timeline.md).

The image's helper build takes `BEELINE_RELEASE_SHA` and
`BEELINE_RELEASE_VERSION`; the hand-build script supplies the checkout SHA.
`scripts/stage-free-agent-helper.sh` builds the canonical helper bundle from
that checkout. Image construction verifies its SHA, version and digest, then
installs it through the existing recovery installer in an isolated build stage
under `/opt/beeline/helper`. The entrypoint launches that image-owned helper
directly, so an older release pointer in persistent HOME cannot select the runtime.
`node --test infra/free-agent/entrypoint.test.mjs` covers stale-HOME boot selection,
and helper exit propagation. The [persistent boot recovery proof](free-agent-persistent-boot-proof.md)
records a disposable Fly Machine cold stop/start and the stale-owner regression.
After building the server and image, `node infra/free-agent/cold-start-proof.mjs`
creates a disposable local database and fresh test Workspace, then drives the
real server, image and Pi through a mention and reply. Docker substitutes for
Fly and an immediate local model response substitutes for the provider; the
timed artifact identifies both stand-ins. Set `PROOF_IMAGE` to choose an image.

Reproduction `cold-beebee-first-reply`, Tubing Crew on 2026-10-16: mention
17:52:42Z; Machine booted 17:52:58Z; helper download 17:53:00–17:53:17Z;
Room serving/first activity 17:53:23Z; model catalog 17:53:27Z; first model call
17:54:00Z; reply 17:54:09Z (87 seconds total). Session startup logs UTC timestamps
and monotonic step durations for configuration, home preparation, toolchain,
MCP bridge, ACP initialization and session creation, separating helper
preparation from provider time when investigating the 37-second gap. A local
cold run measured 7,762 ms reinstalling the already-installed Pi/ACP packages
into a Workspace generation. Rooms and corners use the installed host
harness directly, without cloning it into a Workspace generation. Free-agent
images allocate the normal 128 MiB recovery reserve during construction, so a
matching image needs no reserve allocation on its first turn.

## Starter onboarding (revision 4)

The Beebee/Luna/Beebee banter precedes the greeting, which ends with “What should
we work on?” and has no suggestions or choice card. Luna’s second line may hope
for code in the person’s repo or one specific everyday task. The onboarding
`invite` tool prints an invite link in chat when requested. The funnel
`invite_shared` milestone means that committed chat post, not a native share action.


## Manual onboarding and Luna backfill

Agents can load the `beeline-onboarding` skill, discover
`app_tool(app:"beeline:onboarding")`, and call its `welcome` action. This reuses
signup's banter and open welcome question in the calling chat. Unrelated
questions retain their normal open-choice rule. Signup still posts its welcome directly on the server.

Manual welcome messages carry `onboardingManual` and a separate run ID. Their server events
use that run ID as an internal funnel install/attempt with version `manual`, so
signup cohorts exclude them. Game viewer and invite milestones also follow the manual run. Older clients' welcome events
are routed to the manual run on the server.

After building the server, `npm run backfill:luna` prints the production target
inventory without writes; provide `DATABASE_URL` through the operator's approved
secret environment. `npm run backfill:luna -- --apply` requires the owner's
approval of the dry-run list after release. The script enforces the six excluded
workspace IDs in `apps/server/src/luna-backfill.ts` for the free-Beebee sweep.
The explicitly assigned Room `289fbeab-3df5-4db3-9b70-d2fd3b937cae` is a separate
exception inside Tubing Crew; no other Room in a skipped workspace is targeted.
Its resolved workspace and explicit-Room label appear in the inventory. A missing
explicit Room aborts the inventory rather than selecting a replacement.
The owner approved `LUNA_BACKFILL_HELLO` beside Beebee's hello (approval relayed
by Ruby, message ae9a4279). The CLI uses only the frozen workspace/Room pairs
in `scripts/luna-backfill-approved.json`; new signups do not expand this run.
A missing approved pair stops before writes and requires a new decision.
The two additional exclusions are jellybean-beeline-test's team and Methoxine's
team, both matched by workspace ID. Apply remains an operator action after merge
and release; approval does not execute it.
It serializes each workspace
and owner, reuses normal free-agent provisioning and its owner cap, and commits
Luna and a deterministic per-workspace intro message together. An existing Luna,
including a removed one, is never duplicated. It makes no Fly or model calls.
Normal subscribed membership notifications still apply to other agents.

## Next-morning check-in

There is no automatic next-day check-in.
