# Reproduction db-lock-1

Production collector files on squire were read for November 9 after 21:12 UTC
and November 10 through about 15:40 UTC. They contain 264 `55P03` entries;
249 adjacent previews identify the lifecycle reader starting
`SELECT fact.machine,corner.parent_id` (`be2c1967931d7f1c`). A request at
00:44:51 UTC failed at transaction COMMIT while posting a corner message.
The logs record victims, not blocking backend IDs or holder statements.
The earlier PR (#4157) added one retry to corner attention refresh; it did
not add holder diagnostics. These later events show the contention remains.

Fly live logs also opened successfully using the owner's org-deploy vault
credential. Neon read-only activity snapshots succeeded using the owner's
beeline-prod-db credential. Neither snapshot caught an active blocker.
The read role is schema_admin and has pg_read_all_stats. No production writes
were performed. An initial activity response could not serialize a native
array; JSON aggregation returned the activity correctly.

The historical holder cannot be reconstructed from these logs. Per the brief,
this change ships holder logging first, without guessing a transaction fix.
Production contention is therefore not claimed fixed. The next production
lock-timeout log supplies the observed blocking backend, redacted query shape,
query ID, state and transaction age, or explicitly states no observation.
An idle transaction's query is its last observed statement, not proof that
that statement originally acquired every lock. The sampler observes before
cancellation because pg_blocking_pids is empty after the timeout.

The regression uses the same migrated lifecycle reader against isolated real
PostgreSQL and a concurrent request event to admit the passive observation, with a planted holder of its corner_facts row and a 500ms lock
budget. This is a stand-in for the unknown historical writer. Before the
change, the timeout had no holder log; after, the log identifies the planted
holder and omits its literal values. Releasing the holder lets the same
reader return the corner. Pool tests also failed before the change because
query, transaction and dedicated checkout timeouts logged no occupancy.

## Built service demonstration

Build shared packages and the server with `npm run corner:prepare` and
`npm run build --workspace=@beeline/server`. Then run
`BEELINE_COMMAND_TEST_POSTGRES_URL=<isolated-loopback-url> node --import tsx scripts/prove-database-timeouts.mjs`.
The script creates and drops its own database. It does not use a production URL.

The compiled background corner reconciliation logged the planted holder before
its timeout. After holder release, reconciliation completed and the phone's real
live socket listed the corner. On that same built service an established phone
socket tried readRoom with the sole app connection checked out. It returned a
retryable unavailable response and logged inUse=1, waiting=0 and
waitingAtCheckout=1 (the failed waiter has already left pg-pool's queue).
Returning the connection let the same socket load the Room successfully.

The sampler shares the existing diagnostics pool across app, enrichment and
job pools, permits one observation request at a time, with at most one probe admitted per 100ms by statement start/completion events.
There is no diagnostic timer or polling loop. No statements means no probe. Blocker probes never delay the request or retry SQL.
The first checkout of a physical connection performs one identity read before
executing application SQL. Short/NOWAIT failures, waits beginning after the last source event, or an unavailable
observer can miss the holder; the log labels that explicitly. Query text is
redacted before logging, including comments and truncated string literals.
Only explicit `E` strings use backslash escapes; quoted identifiers use doubled
quotes. Ordinary strings containing backslashes suppress the entire query as
`[SQL redacted]`, because activity text does not include the session's
`standard_conforming_strings` setting. The built proof also executes the review's
backslash-ending standard string against PostgreSQL and verifies that both the
waiting statement and holder query suppress the private literal.
Diagnostic query IDs come from PostgreSQL; the accompanying fingerprint hashes
the redacted shape, not literal values. Production activity confirmed app and
long-running connections also use schema_admin, which can observe their peers.
A read-only command inside the production Fly machine also compared the driver's
processID with SELECT pg_backend_pid(): Neon returned different values even on
its direct endpoint. The wrapper therefore resolves and caches the real backend
PID once per physical connection; it never uses the proxy cancellation PID to
join pg_stat_activity. No connection string or credential was printed.

Validation: the new checkout cases and real PostgreSQL reader diagnostic failed
against the prior database wrapper with no diagnostic calls. The targeted
database, transaction-contention, redaction and error-context suites passed.
The compiled phone-socket demonstration above passed. Server and shared
workspace typechecks passed. Root typecheck reached mobile and stopped because
this corner lacks @expo/router-server/build/typed-routes; mobile preparation
was requested. Mobile source is unchanged.
