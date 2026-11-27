#!/usr/bin/env bash
set -euo pipefail

collector="$(dirname "${BASH_SOURCE[0]}")/collect.sh"
scratch="$(mktemp -d)"
trap 'rm -r -- "$scratch"' EXIT
mkdir "$scratch/credentials"
printf 'test token\n' > "$scratch/credentials/fly-api-token"
cat > "$scratch/flyctl" <<'FLYCTL'
#!/usr/bin/env bash
if [[ -n ${TEST_FLY_LINE:-} ]]; then
  printf '%s\n' "$TEST_FLY_LINE"
fi
exec sleep "${TEST_FLY_WAIT:-0}"
FLYCTL
chmod +x "$scratch/flyctl"

export CREDENTIALS_DIRECTORY="$scratch/credentials"
export LOG_COLLECT_FLYCTL="$scratch/flyctl"
export LOG_COLLECT_KILL_AFTER_SECONDS=0.1
export LOG_COLLECT_PAUSE_SECONDS=0.1

app=test-app
old="$(date -u -d '20 minutes ago' +%FT%TZ)"
fresh="$(date -u +%FT%TZ)"

seed_log() {
  local root="$1" timestamp="$2"
  mkdir -p "$root/$app"
  printf '%s seed line\nuntimestamped detail\n' "$timestamp" > "$root/$app/${timestamp:0:10}.log"
}

expect_exit() {
  local expected="$1" time_limit="$2" window="$3" root="$4" status=0
  LOG_COLLECT_WINDOW_SECONDS="$window" timeout "$time_limit" bash "$collector" "$app" "$root" \
    2> "$scratch/collector.err" || status=$?
  if [[ $status != "$expected" ]]; then
    printf 'Expected collector exit %s, got %s\n' "$expected" "$status" >&2
    cat "$scratch/collector.err" >&2
    exit 1
  fi
}

seed_log "$scratch/stale" "$old"
TEST_FLY_LINE="$old seed line" expect_exit 1 3 0.2 "$scratch/stale"
grep -Fq "Raw logs for $app are stale:" "$scratch/collector.err"
grep -Fq "last timestamp: $old" "$scratch/collector.err"
test "$(wc -l < "$scratch/stale/$app/${old:0:10}.log")" -eq 2

seed_log "$scratch/fresh" "$fresh"
expect_exit 124 1 0.2 "$scratch/fresh"
test ! -s "$scratch/collector.err"

seed_log "$scratch/recover" "$old"
TEST_FLY_LINE="$fresh recovered" expect_exit 124 1 0.2 "$scratch/recover"
test "$(grep -Fxc "$fresh recovered" "$scratch/recover/$app/${fresh:0:10}.log")" -eq 1

near_deadline="$(date -u -d '897 seconds ago' +%FT%TZ)"
seed_log "$scratch/silent" "$near_deadline"
TEST_FLY_WAIT=15 expect_exit 1 9 600 "$scratch/silent"
grep -Fq "last timestamp: $near_deadline" "$scratch/collector.err"

printf 'Collector freshness tests passed.\n'
