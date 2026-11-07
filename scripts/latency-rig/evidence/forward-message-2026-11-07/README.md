# Forward-message profile and stop-timestamp correction

Reproduction FORWARD-WEB-1: open the seeded message menu, choose Forward, and
select the open-room destination. Completion requires the real server-accepted
message, the picker leaving the DOM after its unchanged exit animation, and two
animation frames. Committed database effects are checked after every sample.

The original driver-observed baseline was p50 850.6 ms / p95 880.3 ms. The prior
unchanged reproduction measured 846.9 / 865.4 ms. The corrected primary metric
below is a different timing contract; its difference from those numbers is not
an app speedup. Both before/after captures below use the **same corrected rig**.

## Conditions and reproduction

Both runs use production Expo exports on squire, Chromium 158.0.8127.18,
390 × 844 viewport, loopback server port 18090, web port 18089, no injected RTT,
no CPU throttling, and the original fixture reset, click and effect check.
Each run contains two batches of twenty forwards. Selecting the interaction
leaves all other inventory entries explicitly unmeasured and the full score null.

```
LATENCY_RIG_WEB_INTERACTION=forward-message \
  bash scripts/latency-rig/web-run.sh .beeline-proof/forward-after
```

The before app is main 43e3022a2 with this PR's corrected rig applied, before the
mobile changes. The after app and rig are 0a9126247. `provenance.json` identifies
both exports' entry scripts. Capture, fixture, driver, observer, route and
inventory hashes are identical between runs and match the committed rig.
The before summary records its base commit because the rig was still uncommitted;
the full source hashes identify the actual measuring code. The after summary
records the implementation commit. Subsequent commits add evidence only.

## Profile

All numbers are milliseconds. Percentiles are pooled across forty samples;
segment percentiles are independent and do not add to the total percentile.
Animation duration is the CSS animation event's elapsed time. Socket timing
includes local transport, server processing and client reply handling; it is
not a pure server CPU duration. There is no worktree creation, git clone or
checkout on this Room-forward path.

| Segment | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Driver start to DOM click | 32.6 / 43.4 | 34.7 / 45.1 |
| DOM click to socket send | 19.3 / 34.2 | 0.3 / 0.4 |
| Socket send to matching reply | 26.7 / 122.0 | 65.4 / 149.0 |
| Reply to picker exit animation start | 30.0 / 39.1 | 32.9 / 42.8 |
| Exit animation (design floor) | 250.0 / 250.0 | 250.0 / 250.0 |
| Animation end to picker DOM removal | 1.3 / 3.9 | 1.9 / 2.7 |
| Removal to two result frames | 31.8 / 32.0 | 31.2 / 31.7 |
| Corrected start to removal + two frames | 393.2 / 488.4 | 411.4 / 500.2 |
| Original driver-observed duration | 846.9 / 885.1 | 863.4 / 884.5 |
| Driver stop minus in-page stop | 450.0 / 483.3 | 449.9 / 483.3 |

## Measured change and limits

An existing destination Room used an async resolver that already knew the Room
id. Awaiting that resolved promise yielded to the busy-picker render before the
send. The resolver now returns existing Room ids synchronously, and the caller
only awaits member destinations that actually require DM resolution. This
removes the pre-send yield: click-to-send p50 falls from 19.3 ms to 0.3 ms.
Member resolution, error handling and waiting for server acceptance remain intact.

The measured end-to-end median did **not** improve in these paired runs: the
socket/reply segment was higher in the after capture. We claim the measured
pre-send reduction and the corrected observation contract, not an end-to-end
speedup. The after total remains 411.4 ms p50 / 500.2 ms p95. The fixed 250 ms
animation remains the requested design floor; the 150 ms goal is not a gate.
The remaining reply-to-animation gap covers ordinary state commit and animation
presentation; this PR does not change that visual path.

## Guards and checks

- The existing nightly web regression now checks corrected and original driver
  percentiles separately; running it against the old capture code fails because
  the original driver field is absent.
- The local Chromium observer regression proves a later driver read cannot move
  the saved stop, unrelated replies cannot satisfy it, and probes restore
  themselves. The original two-frame policy remains in both timings.
- The mobile resolver test fails against the old async resolver, then passes
  with the change. It also keeps new member DMs asynchronous until accepted.
- Root typecheck, nightly latency tests, the local observer test, focused mobile
  tests, and referenced-path checks passed. Both production web exports and
  all eighty before/after forwards completed with committed-effect verification.
- No test was skipped. Native/emulator/device capture and the full mobile suite
  were outside this web-only change; the focused mobile guard and root
  typecheck cover the changed mobile code. Chromium is a local proof dependency,
  not a new prerequisite for the browser-free nightly CI suite.

A provisional inventory run was interrupted before final capture to freeze the
rig sources; it contributes no measurements here. No timers, request caps,
retry loops or optimistic forward acceptance were added.
