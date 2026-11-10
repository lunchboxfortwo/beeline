# FORWARD-WEB-1: distinguish configuration, observed close, and rendered completion

The follow-up asked whether the quarter-second close was a measurement mistake.
No animation code changed. The rig now reports configured CSS duration separately
from the measured animationstart-to-animationend event interval, and exposes
close start, unmount, tap-to-gone, and source-message visibility timestamps.
A missing visibility observation remains null, never a fabricated zero.

## Code path

- `apps/mobile/sources/components/buzz/HullActionSheet.tsx:305` uses HullModal
  without an animation override. Its onDismiss is optional and not supplied by
  the forward picker.
- `apps/mobile/sources/components/buzz/HullDialog.tsx:254` defaults to fade,
  and line 327 passes that to React Native's platform Modal. The Android-only
  FadeOut duration at line 318 does not run on this web rig.
- Installed React Native Web `dist/exports/Modal/ModalAnimation.js:14` sets
  ANIMATION_DURATION to 250. Lines 82 and 87 apply that duration to CSS entry
  and exit. Its animationEndCallback (line 36) sets isRendering false (line 47)
  on exit; lines 66–70 retain the children until then. onDismiss runs later
  (line 51), not as an admission step before hiding.
- `scripts/latency-rig/web-forward-timing.mjs:49` observes actual picker DOM
  removal. It does not infer removal from animation duration, onDismiss or a
  timer. The original completion metric then includes two result frames
  (lines 68–75), separately retained from tap-to-gone. Socket acceptance comes
  before close start; that round trip is not counted as animation.

## One actual tap, relative to the unchanged driver start

The first retained sample in captures.json has these in-page marks (ms):

| Mark | Time |
| --- | --- |
| Driver start | 0.0 |
| DOM target click | 37.4 |
| Send | 37.8 |
| Matching server reply | 87.8 |
| Close animationstart event | 116.5 |
| Close animationend event | 349.7 |
| Picker unmounted (“sheet gone”) | 351.0 |
| Existing source message hit-test visible | 366.5 |
| Second result frame / primary stop | 383.0 |
| Original driver-observed stop | 849.5 |

That sample's observed event interval is 233.2 ms while CSS reports 250 ms.
Animation events are delivered at frame boundaries; configured CSS duration
and event-callback elapsed time are distinct measurements. Across the full pair,
the observed interval median is 249.9 ms, not zero. The source message is the
message visible in the current Room after the sheet closes. The forwarded copy
belongs to another Room; it is not displayed in this route. Its server acceptance
and committed destination effect are verified, not mislabeled as visible here.

## Fresh paired capture

Production Expo web export on squire, Chromium at 390 × 844, no injected network
delay, original loopback fixture. The merged main includes the create-corner rig
changes; both measurement branches and their guards coexist. Command:

```
LATENCY_RIG_WEB_INTERACTION=forward-message \
  bash scripts/latency-rig/web-run.sh .beeline-proof/forward-close-audit
```

Two batches of twenty completed forwards; raw samples and source hashes are
retained here. All capture source hashes match the committed implementation.
Independent segment medians do not sum to the median total.

| Metric | p50 ms | p95 ms |
| --- | --- | --- |
| Driver start → DOM tap | 34.2 | 37.5 |
| Tap → send | 0.2 | 0.3 |
| Send → reply (transport/server/client handling) | 39.0 | 52.1 |
| Reply → close start event | 28.3 | 39.4 |
| Observed animation event interval | 249.9 | 250.1 |
| Configured CSS duration | 250.0 | 250.0 |
| Close start event → sheet gone | 251.1 | 251.5 |
| Animation end → DOM removal | 1.3 | 1.6 |
| DOM tap → sheet gone | 313.7 | 330.3 |
| Removal → original two result frames | 31.9 | 32.1 |
| Original start → in-page two-frame completion | 380.9 | 396.3 |
| Original driver-observed total | 844.7 | 861.9 |
| Driver observation lag | 450.0 | 466.7 |
| Original start → source message visible | 364.4 | 379.9 |

The large measurement error is the driver's observation lag. CSS really is
configured for a quarter second, and the fresh observed event interval agrees.
The earlier single visual-take difference (330.4 versus 57.1 ms) is consistent
with removing this exit plus request/render variability; those separate takes
cannot isolate an exact causal delta. A visually subtle fade can still retain
its DOM for the configured interval. No timer, retry, callback admission or
extra network request explains the close interval.

The board had already been published before the cancellation reached the
implementer. No further board work or animation modification was performed
in this follow-up. The shipping diff still has no animation changes.

Root typecheck and the combined nightly/observer regression suite (17 tests)
passed. The observer test now rejects reporting configured CSS time as an
observed event interval; the summary guard keeps unavailable visibility null.
The production capture passed all forty committed effects. No tests skipped;
native-device capture is outside this web measurement follow-up.
