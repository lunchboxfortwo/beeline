# Local web latency proof

Reproduction 27/28 and Reproduction 4 use a production Expo web export,
Chromium 158, a phone-sized web viewport (390 × 844), no CPU throttling, and a
disposable loopback PostgreSQL fixture. Production and native measurements are
outside this brief. Main was integrated before the baseline; its Room-open
batching patch is present in both exports. The mounted dependency lacked that
patch, so both exports used the same private, patched dependency copy. The
rejected asynchronous-route export and stale-dependency runs are not baselines.

Each performance row has forty samples, excluding a separately profiled sample.
Cold document loads clear HTTP, surface, outbox and IndexedDB caches while
retaining sign-in. Their passive in-page observer freezes the result after
content is laid out across three consecutive animation frames. The driver reads
that frozen timestamp later; its selector polling cannot move the result. This
is a frame proxy, not physical scanout. Historical driver-observed cold numbers
(838/596 ms) are a different boundary and must not be compared directly.

| User path | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Room list, cold | 537.8 ms | 490.0 ms | 594.1 ms | 522.7 ms |
| Transcript, cold | 339.5 ms | 296.4 ms | 375.3 ms | 325.1 ms |
| Corner create, recognition to visible destination | 232.1 ms | 215.2 ms | 284.1 ms | 231.5 ms |
| Corner close | 188.9 ms | 178.6 ms | 235.5 ms | 201.7 ms |
| Room leave | 113.3 ms | 103.9 ms | 128.2 ms | 111.4 ms |
| Room open | 98.5 ms | 97.8 ms | 110.4 ms | 114.3 ms |

The largest single cold-load span in the baseline trace is parsing the main
bundle (165.4 ms for the Room list; 165.7 ms for the transcript). Importing the
whole icon barrel includes unused font families, and the error-reporting SDK
includes integrations even on a healthy launch. Direct icon-family imports and
loading the reporting SDK on the first web error reduce the main script from
about 9 MB to 6.3 MB. Early errors/rejections retain their route and pass through
the existing SDK filter and cap. Native still initializes eagerly.
The earlier diagnostic export had parse spans of 127.2 ms and 118.4 ms.
The final module split was then re-exported and measured in alternating AB/BA
order, with the inactive document blanked; the table uses that final run.
Its separate CPU profiles and exact asset names are included in the proof. Background parse
spans overlap other work and are not added to React task durations.

Creation likewise freezes an in-page destination frame: a changed Room URL,
laid-out corner header and composer, and no visible hydration loader. It can
finish during the unchanged long press, before gesture cleanup or a driver
read. The original driver-observed creation clock was effectively unchanged
(231.8 ms before, 232.2 ms after); that is not presented as an improvement.
Both raw clocks and their profiles are retained. Close and leave retain their
existing driver-observed result plus two frames; Room open retains the existing
busy-Room visible-frame predicate.

Corner creation no longer redraws its departing conversation merely to set an
in-flight guard; the guard remains synchronous against duplicate gestures.
Corner close warms the authorized parent response while the actions are open
and gives accepted navigation priority over resetting its departing sheet.
Room leave likewise gives the destination priority over departing Room cleanup.
Header, transcript and composer have separate memoized render boundaries.

The saved action profiles are correlated with the recognized gesture/action and
visible-result marks. Their blocking main-thread work is React scheduling and
commit, rather than bundle parsing during the gesture: the baseline creation
trace contains a 24.5 ms React callback and 26.2 ms microtask batch; close contains
a 21.6 ms scheduler callback; leave contains a 22.9 ms scheduler callback. These
are individual profiled samples, not percentile measurements or additive costs.
The changes remove the source conversation redraw for the creation guard and
move departing-surface resets behind accepted navigation for close and leave.

Reproduction 4 already falls below the requested 150 ms Room-open median on
current main with its actual patched dependency. The final forty-sample run
retains that margin. No visible content or closed-menu setup is delayed, and no
loading-state or layout change is introduced.

Committed raw samples: [cold before](cold-before.json), [cold after](cold-after.json),
[creation before](corner-before.json), [creation after](corner-after.json),
[action baseline](actions-before.json), and [final actions](actions-after.json).
The attached proof also includes the harnesses, CPU profiles and Chromium
traces. `rig:action-start` and `rig:visible-result` bracket close/leave profiles;
long-press recognition and the destination frame are recorded separately for
corner creation. Cold-frame scripts retain their exact loaded asset names.

Coverage adds explicit fixtures for the current forty-four routes, each cold and
warm, rather than preserving the historical missing-route count. Attachment
selection, upload and delivered content use the real web picker and a disposable
local object store. Native OS picker time is excluded. Unavailable/external
actions remain in the inventory and keep its full score unavailable:

| Action | Availability | Reason |
| --- | --- | --- |
| Mark read / mark unread | unavailable | No current standalone user controls. |
| Workflow start / handoff | unavailable | Agent commands, not web user controls. |
| Merge approval | external | Requires a live exact-head GitHub gate. |
| Connect app | external | Requires provider sign-in and consent. |

Switch Workspace and create Room remain explicitly out of scope. No retired
control, native measurement or production proof gate is added.
