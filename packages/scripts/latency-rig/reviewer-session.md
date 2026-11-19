# Reviewer session for the latency loop

Run `bash packages/scripts/latency-rig/web-run.sh /absolute/output/directory`
from the repository root after installing root/mobile dependencies and Chromium.
The nightly loop calls this entry point before native capture.

The entry point starts its own loopback server, web export, and object store.
`run-local.sh` migrates and seeds `beeline_latency_rig_inventory`, including
**Web Latency Rig** and the 1/10/200-Room fixture Workspaces. The fixed reviewer
identity owns these disposable Workspaces. No owner account, production token,
or production Workspace is used. The existing loopback/database checks apply
before database creation and seeding. The web lane's database and port overrides
are `LATENCY_RIG_WEB_DATABASE_URL`, `LATENCY_RIG_WEB_SERVER_PORT`,
`LATENCY_RIG_WEB_PROXY_PORT`, `LATENCY_RIG_WEB_PORT`, and
`LATENCY_RIG_WEB_OBJECT_PORT`.

After server readiness, `web-capture.mjs` opens the existing `/review/<secret>`
route using `LATENCY_RIG_REVIEW_SECRET`, supplied by `web-run.sh` only to this
local server. This exercises ordinary review-token redemption. It saves
`reviewer-session.json` in the output directory with mode 0600, then closes the
bootstrap context. The file holds only the reviewer's identity/access/refresh
storage keys and cookies, without surface caches or device preferences. Each
run creates a new session; both interaction and route samples restore that
same saved session into fresh contexts, including route-only runs. Login is
outside the measured interval. Keep the output directory private and discard
it with the disposable fixture data; never commit the session file.

Every supported interaction starts at the browser input event and ends when
its explicit fixture result is visible followed by two animation frames.
`captures.json` retains samples and errors; `summary.json` retains paired p50/p95
and coverage. Route samples use navigation time origin through explicit visible
content plus two frames, with cold and warm variants in `route-captures.json`.
Driver observation time remains separate. Unavailable or external interactions
retain their reasons and do not become successful timing samples. For a focused
proof, set `LATENCY_RIG_WEB_INTERACTION=open-room,send-text`; the default runs the
complete inventory. `LATENCY_RIG_WEB_ROUTES_ONLY=1` runs just the route lane.
