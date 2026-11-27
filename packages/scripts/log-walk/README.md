# Production raw log collectors

Fly keeps about 100 lines of log history. Three collectors on squire stream
`beeline-server`, `beeline-free-agents` and `beeline-voice-livekit` into daily
files. The daily report walk has been retired; these collectors remain live.

An operator with vault access stages the existing Fly org deploy token in
`~/.config/beeline-log-walk/fly-api-token` on squire as a single line, owned by
the host user with mode `0600`. systemd reads it on each collector start.

Run `bash packages/scripts/log-walk/install-host.sh` as the host user to install
or update the server and free-agent collectors. It prepares their checkout of
`main` at `~/.local/share/beeline-log-walk/token-checkout`, writes their
environment, and installs, enables, and restarts their systemd units. The voice
collector continues using its existing template, environment, and checkout.

Raw logs land at
`~/.local/share/beeline-log-walk/raw/<app>/<UTC date>.log`.
The systemd journal records stream failures and authentication errors.

`collect.sh` reconnects `flyctl logs` at least every ten minutes, forcibly
terminating streams that ignore SIGTERM. If the newest raw entry is more than
fifteen minutes old after a stream attempt, the collector logs the stale
timestamp to the journal and exits. For an empty log directory, the fifteen
minutes start when the collector starts. systemd restarts the collector after a
staleness failure.
Collectors keep eight days of logs. If Fly rejects the token or systemd cannot
load it, the affected service stays failed. Restart it after the credential is
repaired.

Run `bash packages/scripts/log-walk/test-systemd.sh` with a running user
manager to test the credential setup failure using a disposable service.
Run `bash packages/scripts/log-walk/test-collect.sh` to test raw log freshness
with a simulated Fly stream.
