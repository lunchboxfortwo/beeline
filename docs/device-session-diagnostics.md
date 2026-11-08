# Device and session diagnostics

Beeline records content-free steps for each app installation and visit. The
installation ID is random and shared with the sign-in funnel. It identifies an
installation or browser profile, rather than physical hardware. Reinstalling,
clearing storage or private browsing can produce a new ID; copying storage can
reuse one. Each runtime has a separate view ID. Activity sessions rotate at cold
start, account change, and the first event after 30 minutes idle, without a timer.
Denied storage is labeled `storage_unavailable` and uses an ephemeral identity.

`packages/api-contract/src/diagnostics.ts` owns the finite event and error
vocabulary. Events contain identifiers, route patterns, step outcomes and coarse
build/platform information. They exclude message contents, keystrokes, user
names, URLs, provider bodies, credentials and arbitrary properties. Auth records
separate browser launch, return, callback validation, exchange, persistence and
navigation. A callback is not proof that credentials were saved or a screen
rendered. Shared socket operations supply baseline action coverage for returning
users as well as new accounts.
Unknown and retired socket operations retain their database-free refusal path;
only allowlisted operation names enter the diagnostic journal.

`diagnostics-client.ts` retains at most 256 events and a conservative 256 KiB UTF-8
budget per runtime, using a separate storage key for each occurrence so simultaneous
browser views cannot overwrite each other. Startup prunes an older diagnostic backlog
before saving an installation ID. Oldest observations may be discarded; sequence gaps
and `storage_unavailable` preserve the limits of coverage. Credentials and unsent
messages are never pruned. A failed save parks persistence for that runtime while
bounded in-memory observations can still be sent. Expo update descriptors accept
UUIDv7 build IDs; session and event authority IDs retain UUIDv4 validation.

Each batch has at most 32 events. Acknowledged IDs leave the queue; the server's
global ID ledger deduplicates repeated delivery across receive dates. Offline
failure waits for a real action, foreground/background event, or existing socket
connection event. There is no flush interval, polling, telemetry reconnect or
second authenticated connection. Telemetry never delays an operation for an
acknowledgement. The existing funnel HTTP route accepts anonymous batches;
authenticated batches and legacy signed-in funnel milestones use the main socket.

The server owns identity and auth-family attribution. A session continuity proof
is hashed separately from the journal; it cannot change a previously bound
person. Logout/account changes retain pending events under their original owner.
Anonymous sessions can bind on sign-in, including returning-account sign-ins.
The operator must distinguish client observations from server facts. Device and
session IDs convey no Room or work authority.

Workspace creation writes one `workspace_creation_facts` record in the existing
creation transaction. The source is `manual_ui`, `onboarding`, `mcp_consent` or
`recovery`. Replaying the same Workspace ID does not create another fact. The
client uses that Workspace ID as the stable creation action across transport
attempts. Command origins retain the initiating session/action across durable
queues and child commands. Command state observations never claim or finish work.

MCP Events and member callbacks persist attempt/completion times, HTTP status,
duration, result and a finite failure category. `delivered` means a successful
HTTP receipt. A failed callback, skipped access state, and unknown host execution
remain distinct. Historical `delivered_at` remains a processed marker for rollback
readers; use the additive `delivery_state` fields. Legacy rows default to unknown.
No callback result proves model execution. Explicit no-reply, failure and committed
reply evidence are projected separately in the operator read. Claims without a
completion remain unknown, including process loss. Nothing retries delivery or
starts an agent because of diagnostics.

## Private operator view

`GET /v1/admin/diagnostics?person=<identity-or-handle>` returns the server-indexed
person → devices → sessions → actions view. Add `format=html` for the responsive,
server-rendered view. The API uses `BEELINE_DASHBOARD_SECRET`; never put this secret in browser code
or a URL. The separate `beeline-dashboard` repository currently exposes only
aggregate dashboard calls. Its server-side proxy needs explicit diagnostics
routing before this view can be opened inside that console. There
is no phone-accessible diagnostic reader. Successful reads write a private audit
record, and responses use `Cache-Control: no-store`. The HTML has no script,
polling or network sender and applies a restrictive content security policy.

The view includes client and receive timestamps, view sequence gaps, explicit
coverage, workspace provenance and separate assistant transport/host outcomes.
Unknown-device server events remain visible. No observations means missing
coverage, rather than zero failures. Sessions order client events by their own
sequence; receive time remains visible because client clocks can be skewed.

The journal is range-partitioned by receive date with a default partition and
leaf indexes. Global ID keys make retries independent of the receive date. The
existing diagnostics database pool handles ingress, operation observations and
operator reads; transactional domain provenance stays with its domain writer.
Existing funnel maintenance deletes journal detail after 30 days, anonymous
sessions after seven inactive days, sessions after 30 inactive days and device
registry rows after 90 inactive days. Claimed identity/session rows cascade on
account erasure. Existing Sentry exception filtering and PostHog product analytics
remain; this journal adds no vendor, replay, or external content export.

## Local proofs

Run one suite at a time with `--maxWorkers=2 --minWorkers=1`:

- Server `src/diagnostics.integration.test.ts`: three devices, returning sessions,
  account isolation, authoritative creation/replay, durable command origin,
  delivery distinctions, offline restart/drain beyond 1,000 queued events,
  dedupe, denied storage, skew/gaps, privacy, deletion, real anonymous HTTP and
  authenticated WebSocket admission, and private operator HTML.
- Shared `src/diagnostics-client.test.ts`: simultaneous views persist and recover
  both queues without replacing each other.
- Mobile `sources/auth/auth-diagnostics.test.ts`: actual browser opener,
  exchange transport/refusal, credential persistence and navigation failures.
- Mobile `sources/sync/transport/live-connection.test.ts`: one socket, bounded
  batches, no recursive diagnostic events or polling, and domain completion while
  diagnostic acknowledgement is withheld.

These use isolated local databases and fixtures. They do not drive helper
lifecycle, write production data or claim visibility inside an uninstrumented host.
