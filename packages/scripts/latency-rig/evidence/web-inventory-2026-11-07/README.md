# Paired web inventory capture

Feature request; not a defect report.

Run `bash packages/scripts/latency-rig/web-run.sh .beeline-proof/inventory-final` on the measured commit in summary.json. The runner builds the production Expo web export, migrates and seeds its own local `beeline_latency_rig_inventory` database, and captures against server port 18090 and web port 18089 (unused local proxy port 18091). No emulator or production Workspace is involved.

The full inventory completed: 52 capture decisions, 19 measured interactions with two batches of 20 samples each (760 timings), and seven explicit unsupported boundaries. Both batches passed for every supported interaction. `summary.json` retains pooled/per-batch p50 and p95 and the exact reason for every unmeasured interaction. `captures.json` retains every sample. `fullInventoryScore` is null until the seven boundaries can be measured. No external browser requests were attempted.

These are headless Chromium rendered-feedback upper bounds including driver overhead and two animation frames, not physical scanout or native Android timings. Setup and reset are excluded; mutations also verify their committed database effects after timing. Capture source hashes were verified against the implementation after the run. The following commit adds evidence only.

Validation: root typecheck, all 11 nightly rig tests, referenced-path checks, shellcheck for both changed shell scripts, and architecture checks passed. Missing-fixture guard: removing open-room fails with `Missing fixture: open-room`.

The unchanged route-budget checker still fails on existing route drift, including helper modules and browser-share/google-callback; this inventory lane validates each fixture starting route against routes.json independently. Native Android capture was omitted as required by the brief.
