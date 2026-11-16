# Reproduction 25 and 26 — local navigation and forwarding proof

The owner approved card items 25 and 26 in message e52dc8840e87de9f1b5d051d3ab536f48fc8df3c31686e7327ed2b7cc72ae477. Brief revision 1 permits FORWARDED feedback during sheet dismissal; no mock was supplied. The loading surface, sheet design and animation curve are preserved.

## Reproduced

Reproduction 25: unchanged main 1391cab1720d74642debc22abce11a8bf9f5ced8, production Expo web export against disposable loopback PostgreSQL/backend fixtures. Reuse the rig's open-room tap for a Room and an existing DM with direct participants. Clear browser response/outbox caches before each setup. The original stylesheet regression fails because thirty additions cause thirty full writes.

The earlier rig started the existing-DM timer before its row existed. Passive dispatch diagnostics found the row absent in every diagnostic sample. The shared open-room setup now waits for the actual row before returning the action, matching the other drivers and the documented setup-before-timer contract. Its regression fails before the correction. Both final baseline and final after measurements use this same corrected setup. The original draft's nonmatching timings are superseded.

Reproduction 26: long press the message fixture, select Forward, select an existing Room, verify the matching accepted server write and the committed database effect. The original component has no accepted feedback; its visible completion is picker dismissal followed by two frames. The fixed observer independently records accepted feedback, exit animation and dismissal. This intentionally changes the result boundary; it does not claim dismissal itself became faster.

Forty samples per path, two consecutive groups of twenty in the same browser context with document/cache resets, Chromium 158.0.8127.18, phone-sized web viewport 390 × 844. No CPU throttling or injected network delay. Build, test, Android capture and benchmark ran sequentially for the final measurements. These are local headless DOM observations plus two frames, including driver dispatch, not physical scanout or a reproduction of live production network conditions.

| Path | Before p50 / p95 (ms) | After p50 / p95 (ms) | Median budget (ms) |
| --- | --- | --- | --- |
| Room open | 164.8 / 216.7 | 149.2 / 201.4 | 150 |
| Existing DM open | 166.9 / 190.3 | 146.6 / 167.8 | 150 |
| Forward result | 381.3 / 383.7 | 114.3 / 119.6 | 250 |

The final local medians meet the assigned budgets. Room and DM p95 remain above 150 ms: this is not a guarantee that every tap finishes within that time. Bone single samples are visual checks, not percentile evidence. Raw samples are before-serial.json and after-serial.json. Desktop JSON records screenshot scenarios only; direct desktop navigation is not a comparable tap measurement. The desktop forward picker was opened at phone width and then resized because the existing desktop long-press driver did not open the menu.

## Demonstrated

Reproduction 25: Unistyles additions/removals coalesce into one scheduled sheet update before the next paint, including additions separated by a microtask in the same frame. The non-browser fallback uses a microtask. The update uses textContent rather than the layout-aware innerText setter. The regression executes the actual patched dependency and guards every touched path as web CSS state only.

The route profile exposed cold-open work before readRoom could be handled: asynchronous cache lookup delayed a known viewer's missing-row read; a cache miss waited two frames despite having nothing to paint; the full transcript mounted once empty and again with its response. The fixed path starts the scoped missing-row read on the tap, keeps the known viewer scope, pre-evaluates route code without mounting or reading a Room, skips the empty yield/reset, and uses the existing loading surface until the canonical response arrives. Once mounted, the transcript remains mounted through refreshes and failures. Existing outbox mount recovery remains in place. Cold-read, cold-scope, empty-yield/reset and route-mount regressions fail before their changes. Rejected history-delay and layout-effect experiments are absent from the final implementation.

The fixed export used a private dependency copy patched with this exact committed patch; patch-package installation passed and its three source hashes match the export's private copy. Temporary Metro configuration was restored. CI's mobile cache hashes patches. The fingerprint exemption covers strictly web JavaScript and is guarded by touched-path assertions; native runtimes remain Android 47 and iOS 38.

Reproduction 26: the accepted destination renders FORWARDED after the server accepts the send. A native layout event and two frames precede dismissal. Failed sends keep the picker and error; they never announce success. Destinations survive until onDismiss, so feedback remains during the unchanged exit animation. Every final timed web sample records the accepted-result frame before animation end with the same configured 250 ms animation.

The Android clips use the existing emulator-5626, isolated debug package and current local source bundle against the loopback fixture backend. Both contain visible FORWARDED frames while the sheet is still present. after-native-visible-result.json indexes extracted frames; after-phone-*-forward.png are actual clip frames. These demonstrate native visible behavior, not native release latency or physical scanout timing. The recordings include the existing development overlay. Before/after source hashes identify the input files; timestamps and forwarded fixture rows are test data.

## Visual evidence

| Surface / theme | Room before / after | Forward before / result after | Recordings |
| --- | --- | --- | --- |
| Phone Bone | [before](before-phone-Bone-room.png) / [after](after-phone-Bone-room.png) | [before](before-phone-Bone-forward-picker.png) / [after](after-phone-Bone-forward.png) | [before](before-phone-Bone-forward.mp4) / [after](after-phone-Bone-forward.mp4) |
| Phone Obsidian | [before](before-phone-Obsidian-room.png) / [after](after-phone-Obsidian-room.png) | [before](before-phone-Obsidian-forward-picker.png) / [after](after-phone-Obsidian-forward.png) | [before](before-phone-Obsidian-forward.mp4) / [after](after-phone-Obsidian-forward.mp4) |
| Web Bone | [before](before-web-Bone-open-room.png) / [after](after-web-Bone-open-room.png) | [before](before-web-Bone-forward-picker.png) / [after](after-web-Bone-forward-result.png) | — |
| Web Obsidian | [before](before-web-Obsidian-open-room.png) / [after](after-web-Obsidian-open-room.png) | [before](before-web-Obsidian-forward-picker.png) / [after](after-web-Obsidian-forward-result.png) | — |

Phone-viewport web images accompany the timed paths separately as *-phone-web-*.png.

Validation: root typecheck; 138 affected mobile tests; 15 browser timing/inventory tests; UI component policy; referenced paths; native fingerprint; patch-package installation. Before logs retain the failing regressions. Full mobile/native release suites were skipped locally; CI owns broader coverage. No production workspace or release was changed.

To replay, serve separate unchanged and patched production exports and start the loopback latency fixture backend using packages/scripts/latency-rig/run-local.sh and its disposable database. Run capture.mjs from this directory with PROOF_ORIGIN set to each export origin, output directory and before/after argument. PROOF_DEVICE=phone-web selects timed taps and PROOF_DEVICE=web selects desktop visual checks. Keep builds, tests and captures serial. The script contains only synthetic local fixture access; it does not capture a production account.

## CI gate correction

CI reproduced a fingerprint mismatch after installing the Unistyles patch: Android 9f5993250ca7d9e0740a357ad2b88446e241b131 and iOS a8cdf247547f768987bd7ce8c02b6978543e3eee. The prior local fingerprint check used an unpatched dependency mount; excluding the patch file alone did not exclude the installed web files from autolinking's package hash.

The exemption now includes exactly the three patched web CSS state files. The existing batching regression checks that every patched path has an installed-file exemption and still rejects native paths. Both test cases fail against the previous fingerprint config and pass with the correction. Recomputed policy baselines agree for unpatched dependencies and a disposable dependency copy with the exact patch applied: Android 87c32ad6cc92893d9960e4a0abd46a7af69b089c and iOS ca5582714fed51020d6bf8e62934dda127d6a528. Runtime pins stay Android 47 and iOS 38; no native implementation changed. The capture CLI is registered as an explicit Knip entry rather than added to the dead-code baseline; the complete dead-code gate passes locally. Product-path measurements were not rerun for these gate-only changes.
