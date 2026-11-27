#!/usr/bin/env bash
# Stream one Fly app's logs into <raw>/<app>/<UTC date>.log, forever.
# Fly keeps only ~100 lines of history, so the walk needs this running.
# Usage: collect.sh <fly-app> <raw-dir>   (systemd: beeline-log-collector@<app>.service)
set -u
set +x
app="$1"
dir="$2/$app"
mkdir -p "$dir" || exit 1
auth_failed() {
  printf 'Fly authentication failed for %s: %s\n' "$app" "$1" >&2
  exit 77
}

credential="${CREDENTIALS_DIRECTORY:-}/fly-api-token"
if [[ -z ${CREDENTIALS_DIRECTORY:-} ]] || ! token=$(<"$credential") 2>/dev/null ||
  [[ $token != *[![:space:]]* || $token == *$'\n'* ]]; then
  auth_failed 'the stored deploy token is missing, unreadable, or invalid'
fi

export NO_COLOR=1
flyctl="${LOG_COLLECT_FLYCTL:-flyctl}"
window="${LOG_COLLECT_WINDOW_SECONDS:-600}"
grace="${LOG_COLLECT_KILL_AFTER_SECONDS:-30}"
pause="${LOG_COLLECT_PAUSE_SECONDS:-5}"
max_age=900
started_at="$(date +%s)"

stream_logs() {
  local failure status
  # Pass stdout through fd 3 and classify stderr without storing Fly's response.
  # Keep Fly in the worker's process group so the parent can stop it on failure.
  failure=$(
    CI=1 FLY_ACCESS_TOKEN="$token" timeout --foreground -k "$grace" "$window" "$flyctl" logs -a "$app" 2>&1 >&3 3>&- |
      awk '
        {
          line = tolower($0)
          if (line ~ /session (has )?expired|unauthorized|unauthenticated|forbidden/ ||
              line ~ /authentication (failed|required)|not (authenticated|authori[sz]ed|logged in)/ ||
              line ~ /invalid (access |api )?token|token (is )?(invalid|expired|revoked)|no (access |auth )?token/ ||
              line ~ /fly(ctl)? auth login|(^|[^[:alnum:]])(401|403)([^[:alnum:]]|$)/) auth = 1
        }
        END { if (auth) print "auth" }'
    exit "${PIPESTATUS[0]}"
  )
  status=$?
  if [[ $failure == auth ]]; then
    return 77
  fi
  # A timeout is expected when rotating a live stream.
  case "$status" in
    0|124|137) ;;
    *) printf 'Fly log stream for %s exited with status %s; reconnecting.\n' "$app" "$status" >&2 ;;
  esac
}

latest_raw_timestamp() {
  local day timestamp
  local days=("$dir"/20*.log)
  for (( day=${#days[@]} - 1; day >= 0; day-- )); do
    timestamp="$(tac -- "${days[day]}" | awk '$1 ~ /^20[0-9][0-9]-/ { print $1; exit }')"
    if [[ -n $timestamp ]]; then
      printf '%s\n' "$timestamp"
      return
    fi
  done
}

watch_freshness() {
  local first_check=true last='' last_at="$started_at" timestamp age remaining
  while true; do
    timestamp="$(latest_raw_timestamp)"
    if [[ -n $timestamp && $timestamp != "$last" ]]; then
      last="$timestamp"
      last_at="$(date -u -d "$last" +%s)" || return 1
    fi
    age=$(( $(date +%s) - last_at ))
    remaining=$(( max_age - age + 1 ))
    if (( remaining <= 0 )); then
      if [[ $first_check == false ]]; then
        printf 'Raw logs for %s are stale: %s seconds without a fresh entry (limit %s seconds, last timestamp: %s).\n' \
          "$app" "$age" "$max_age" "${last:-none}" >&2
        return 1
      fi
      # Give Fly up to 30 seconds to catch up after starting with stale files.
      remaining="$(awk -v window="$window" 'BEGIN { print (window > 0 && window < 30 ? window : 30) }')"
    fi
    first_check=false
    sleep "$remaining" || return 1
  done
}

# mawk buffers piped input unless told otherwise; gawk has no such flag.
awk_flags=()
awk -W version 2>&1 | grep -q mawk && awk_flags=(-W interactive)
shopt -s nullglob

collect_forever() {
  local last result
  while true; do
    # Skip timestamps already written when Fly replays its buffered logs.
    last="$(latest_raw_timestamp)"
    # Reconnect every window in case the stream hangs silently. flyctl can catch
    # SIGTERM and never exit (2026-10-31: wedged for two days), so -k kills it.
    stream_logs 3>&1 \
      | sed -u 's/\x1b\[[0-9;]*m//g' \
      | awk "${awk_flags[@]}" -v dir="$dir" -v last="$last" '
          $1 ~ /^20[0-9][0-9]-/ { if ($1 <= last) next; f = dir "/" substr($1, 1, 10) ".log" }
          f == "" { next }
          # Lines without a timestamp (proxy error details) go to the current day file.
          { print >> f; fflush(f) }'
    result=${PIPESTATUS[0]}
    if [[ $result == 77 ]]; then
      auth_failed 'Fly rejected the stored deploy token for this app'
    fi
    # Keep 8 days.
    find "$dir" -name '*.log' -mtime +8 -delete
    sleep "$pause"
  done
}

stream_pid=''
watchdog_pid=''
stop_jobs() {
  local pid
  for pid in "$watchdog_pid" "$stream_pid"; do
    if [[ -n $pid ]]; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null
}
trap stop_jobs EXIT
trap 'exit 1' USR1
trap 'exit 143' TERM
trap 'exit 130' INT

# Give each job a process group. The watchdog can interrupt the parent's wait
# and stop the entire stream pipeline without waiting for Fly's kill grace.
set -m
(set +m; collect_forever) &
stream_pid=$!
(
  set +m
  watch_freshness
  kill -USR1 "$$"
) &
watchdog_pid=$!
set +m
wait "$stream_pid"
