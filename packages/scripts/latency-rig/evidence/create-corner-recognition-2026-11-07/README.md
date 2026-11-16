# CREATE-CORNER-WEB-1: recognition timing

Main at capture: `804e65b21` (app/server unchanged). Chromium lower-bound
self-check: two batches of twenty static rendered-result samples, p50 63.9 ms,
p95 65.3 ms after recognition. This is not an app result or an improvement over
the historical 852 ms gesture-inclusive inventory number.

The old driver awaited the full 650 ms hold before observing completion.
Starting the clock at the source's 450 ms recognition threshold alone still
leaves at least 200 ms of mandatory driver wait. The corrected driver watches
the same destination URL and visible composer during the hold, records two
result frames, and waits for release outside the recorded duration. Its
visibility observer runs on animation frames instead of locator retry intervals;
the URL and visible-input completion conditions remain the same.

Reproduce the lower-bound self-check:

```
node packages/scripts/latency-rig/web-long-press-floor.mjs .beeline-proof/floor.json
```

`static-floor.json` retains both timing contracts and exact recognition starts.
The static result uses animation frames to simulate recognition at the threshold
read from the actual header. It does not create a corner or measure the server.

## Service profile stand-in

The current local monolith was built, migrated and seeded by `run-local.sh` on
its own loopback `beeline_latency_rig_create_corner` database. A local review
session opened `/v1/phone/live`. Each of two batches of twenty samples resets
the same create-corner fixture, sends `createHumanCorner` with a fresh UUID,
checks the returned ID, then sends `readRoom` and checks the returned Room ID.
The raw socket spans are in `server-profile.json`; pooled percentiles and
request-scoped SQL probe aggregates are in `server-summary.json`.

| Segment | p50 ms | p95 ms |
| --- | ---: | ---: |
| Create request/reply, including server transaction | 59.0 | 97.7 |
| Covering Room read request/reply | 13.9 | 22.0 |

Median SQL statements completed inside each request window: create 26, read 4.
Summed SQL durations at the median: create 59 ms, read 13 ms. SQL aggregates
are attribution aids rather than an additive decomposition of socket latency;
queries and event fanout may overlap. These are real loopback service timings,
not browser tap measurements. The HTTP proxy's configured RTT is bypassed,
as in the web inventory, which talks directly to the server.

Worktree creation and git clone/checkout were not observed or separately timed.
This fixture has no linked repository or connected helper. The phone scratch
corner handler commits database state; an agent repository-work checkout is
not represented by this fixture. An attempted process trace was refused by
ptrace (`Operation not permitted`), so it does not establish zero child work.
Browser request scheduling and rendering remain unmeasured.

## Completed built-app proof (revision 3)

The managed mobile Expo entrypoint is `apps/mobile/node_modules/.bin/expo`.
No root Expo link is needed. The export succeeded. The default ports were
occupied and the shared inventory database had a migration lock, so this run
used isolated loopback ports 18389–18391 and database
`beeline_latency_rig_corner_7730`. No dependency guard was bypassed.

`main-captures.json` and `main-summary.json` contain the required two batches
of twenty built-app samples. Only rig code differs from main `804e65b21`:

| Recognition timing | p50 ms | p95 ms |
| --- | ---: | ---: |
| Batch one | 248.5 | 297.7 |
| Batch two | 398.1 | 596.4 |
| Pooled | 299.4 | 580.8 |
| Pooled minus requested 63.9 ms static floor | 235.5 | 516.9 |
| Gesture-inclusive, separate contract | 819.7 | 1083.7 |

A repeated two-by-twenty static floor measured p50 65.1 / p95 65.4 ms
(`repeat-static-floor.json`). Floor subtraction describes excess over a
synthetic observer; it is not a corrected physical app latency.

### Profile of the same built app

A separate two-by-twenty profile capture adds passive socket envelope timestamps
and labels only BEGIN/COMMIT in the existing local SQL probe. Diagnostic patches
are retained beside this document; they are not applied to production or the
committed rig. No arguments, results, authentication or SQL text are recorded.
`browser-profile.json`, `browser-segments.json` and `transaction-boundaries.json`
retain the data. The original SQL probe records one BEGIN and one COMMIT per
create trace, and the analysis asserts forty distinct matched traces.

| Measured segment | p50 ms | p95 ms |
| --- | ---: | ---: |
| Recognition threshold to create request observed | 59.4 | 61.7 |
| Create socket request/reply | 64.0 | 95.0 |
| Database BEGIN start through COMMIT end (inside create) | 63.0 | 93.0 |
| Create reply to first Room read request | 23.0 | 37.0 |
| First Room read socket request/reply | 23.0 | 49.0 |
| First Room reply to rendered completion | 87.6 | 108.7 |
| Entire recognition-to-rendered profile capture | 264.5 | 314.3 |
| Profile capture minus requested 63.9 ms floor | 200.6 | 250.4 |

Socket times are Node-observed Playwright events at millisecond resolution;
browser `performance.timeOrigin` aligns the frozen completion timestamp. Event
delivery overhead is included. The last segment is a client/render/observer
envelope, including any subsequent reads, not isolated React CPU time or scanout.
Transaction time is nested inside create RTT. Percentiles are not additive.
The main and instrumented captures show run-to-run variation; this is not a
before/after app comparison and no speedup is claimed.

Worktree creation and git clone/checkout have no measured segment in this
inventory path: this fixture has no repository link or helper. Creation calls
`phoneCreateHumanCorner` and commits the scratch corner in the database before
navigation. These measurements cannot describe repository-work checkout latency.
The earlier refused process trace still does not prove zero child work globally.

Two Room reads were observed per sample. Their overlapping timing does not prove
that one is redundant: room subscriptions and parent-pane reads have separate
surface needs. The create transaction dominates its round trip; the remaining
visible path includes navigation, authoritative Room reads and rendering. No
safe cheap removal was established from this profile, so no application change
was made. In particular, these captures do not justify shortening the long press,
skipping authoritative reads or displaying a corner before commit.

### Reproduce

Run `web-run.sh` with the isolated database/ports and interaction filter, as above.
For the diagnostic capture, apply the two observer patches in a disposable copy,
serve the same export, start `run-local.sh` with the SQL probe enabled, and run
`web-capture.mjs`. `analyze-profile.py` records the exact analysis and input names
used here. The committed raw results allow inspection without rerunning the rig.

Validation: root typecheck passes, including mobile and scripts; all ten current
nightly-web-capture tests pass. The test suite proves exact source-threshold
arithmetic and completion before release. Native/emulator and production corner
lifecycle tests were skipped because only web rig/evidence changed.
