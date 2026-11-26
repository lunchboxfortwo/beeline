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

stream_logs() {
  local failure status
  # Pass stdout through fd 3 and classify stderr without storing Fly's response.
  failure=$(
    CI=1 FLY_ACCESS_TOKEN="$token" timeout -k "$grace" "$window" "$flyctl" logs -a "$app" 2>&1 >&3 3>&- |
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

# mawk buffers piped input unless told otherwise; gawk has no such flag.
awk_flags=()
awk -W version 2>&1 | grep -q mawk && awk_flags=(-W interactive)
while true; do
  # Last timestamp already written, so a reconnect's replayed buffer is skipped
  # (lines in that same second too, or each reconnect would duplicate them).
  days=("$dir"/20*.log)  # Day files sort by name, so the last is the newest.
  last="$(tail -qn1 "${days[-1]}" 2>/dev/null | cut -d' ' -f1)"
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
