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
  queued work provisions the Machine through `FreeAgentService.reconcile` from its committed work event.
  A creator owns at most
  `BEELINE_FREE_AGENT_MAX_PER_OWNER` (default 3) free agents.
- **First boot.** The pinned image contains its compatible helper and Pi. The
  entrypoint launches that baked helper once; it performs no installer download,
  refresh loop or startup watchdog. Bootstrap exchanges the Machine's saved
  bootstrap identity for keys, daemon access and a model token. Files and account
  binding persist on the root filesystem. A lost create reply is reconciled by
  stable agent identity and adopts the existing Machine without replacing files
  or rotating its bootstrap identity.
- **Work and sleep.** Every committed command, connector report, authenticated
  connection, removal, listener recovery and release signal enters
  `FreeAgentService.reconcile`. That owner serializes create, image update, start,
  suspend and destroy across servers. It reads pending/claimed commands, connector
  work, Fly's observed machine/version and current authenticated connection.
  Free helpers never receive Squire install assignments. Saved Squire installation
  rows cannot keep them running or block image replacement; supported Workspace
  connector installs still count as work, matching `daemonConnectorAssignments`.
  Claimed invocations and connector installs finish before image replacement.
  A connected helper with no remaining work is suspended; the provider's completed
  snapshot hands any work committed during suspension back to the same owner.
  There is no countdown, periodic sweep or timed retry.
- **Image replacement and wake.** The owner preserves the full machine config and
  persistent filesystem. A successful image POST does not establish readiness:
  the owner observes completion for the returned Fly version before deciding
  whether an ordinary start is required. Stopped, suspended and created machines
  with work start once from that observation. A started machine awaits its real
  authenticated helper connection. A lost provider reply gets one authoritative
  observation, never a replay of the unknown mutation; saved commands remain
  pending. Recovery after an unobservable provider completion requires another
  actual signal. No external-completion/eventual-recovery guarantee is implied.
  Connection registration manages connection facts only and cannot clear the
  lifecycle owner's token. Model admission uses current connection and claimed
  invocation authority, independently of retired lifecycle fields.
- **Message display.** An accepted pending human command projects starting in the
  existing thinking line. Only a real claim writes a working turn and starts its
  elapsed counter. Terminal work clears the line. Full reads, send receipts and
  socket command projections share the same server projection; the optional
  `runtimePhase` wire field remains for older phones, derived from the command.
  There is no stored preparation phase or synthetic `pending:*` working turn.
  A released helper returns unfinished commands to pending without inventing a
  failure. Explicit Stop, membership and retirement remain authoritative.
- **Removal.** The existing Members remove action admits the agent owner or a
  Workspace owner/admin. Removal from any Workspace retires the free-agent runtime,
  matching the existing global daemon retirement. Its transaction keeps a permanent `removed_at` tombstone,
  revokes model/bootstrap and daemon access, and records `removed`. After commit,
  cleanup deletes the Fly Machine without delaying the removal. A later committed source or real recovery can revisit
  failed deletion, including a Machine created by provisioning already in flight.
  Removed agents cannot bootstrap, wake, or be replaced by
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

`free_agent_events` records factual provisioning, connection, start requests,
suspension, retirement and spend observations. Historical state/phase events remain
available for audit. The physical `state`, `runtime_phase` and retired preparation
columns remain through serving and rollback overlap; current lifecycle and model
admission never read or write their values. Physical removal requires the existing
post-drain contract migration. The operation token is exclusive effect ownership,
not readiness. Only `FreeAgentService` writes and releases it.

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

Runtime preparation is outside execution. Pending commands are saved work;
claims begin execution at the server claim timestamp. The image always runs its
baked helper and pinned Pi/ACP. Free agents have no helper self-update, local
refresh flag, sleep HTTP endpoint or settings/idle-window file. Generic helpers
retain their own release transaction. `free-agent-acquisition.test.ts` covers
connection/model authority, pending presentation and provider observations;
`free-agent-ownership.postgres.test.ts` proves two independent PostgreSQL owners
and the final-read handoff race. Run each Vitest suite separately with
`--maxWorkers=2 --minWorkers=1`.

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
`BEELINE_FREE_AGENT_DAILY_TOKENS`,
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
before deployment. After rollout, the leg verifies the image setting on each server and
`--refresh-free-agents` publishes a release signal to the running owners. It does
not create a second service or claim that a notification is helper readiness.
Startup/recovery/release inventory visits every mapped machine regardless of the
retired state, adopts known metadata mappings, leaves idle identities unprovisioned,
and reports unmapped provider machines as preserved ownership discrepancies.
A failed observation does not skip the rest of that finite inventory.
After release, firstmate verifies that a stopped free agent in a firstmate-owned
test Room answers a fresh message and checks actual image/connection/work facts;
a successful signal or update POST alone is insufficient.
`free-agent-refresh.test.ts` covers all retired state values, deferred claimed
work, partial failures and preserved unmapped machines.
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
Fly (including HOME persistence), and a deterministic
local model response substitutes for the provider; the artifact identifies both
stand-ins. The proof uses two server processes and answers fresh messages after
a cold stop, an image replacement while stopped and concurrent command/release
signals, retaining files and checking one paid-attempt receipt per command. Set `PROOF_IMAGE` to choose an image.

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
