#!/usr/bin/env bash
# Run as a user with a running systemd user manager.
set -euo pipefail

template="$(dirname "${BASH_SOURCE[0]}")/systemd/beeline-log-collector@.service"
restart="$(sed -n 's/^Restart=//p' "$template")"
prevent="$(sed -n 's/^RestartPreventExitStatus=//p' "$template")"
manager=(--user --machine="$(id -un)@.host")
unit="beeline-log-collector-test-$$.service"
cleanup() {
  systemctl "${manager[@]}" stop "$unit" >/dev/null 2>&1 || true
  systemctl "${manager[@]}" reset-failed "$unit" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# /dev/full exceeds systemd's credential size limit and fails before ExecStart.
systemd-run "${manager[@]}" --no-block --unit="$unit" \
  --property="Restart=$restart" --property="RestartPreventExitStatus=$prevent" \
  --property=RestartSec=100ms --property=LoadCredential=probe:/dev/full /usr/bin/true

for ((attempt = 0; attempt < 30; attempt++)); do
  if [[ $(systemctl "${manager[@]}" show "$unit" -p ActiveState --value) == failed ]]; then
    break
  fi
  sleep 0.1
done

state="$(systemctl "${manager[@]}" show "$unit" -p ActiveState -p ExecMainStatus -p NRestarts)"
if [[ $state != *'ActiveState=failed'* || $state != *'ExecMainStatus=243'* || $state != *'NRestarts=0'* ]]; then
  printf 'Expected credential setup to fail without a restart.\n%s\n' "$state" >&2
  exit 1
fi
printf 'Credential setup failure stopped the service without restarting it.\n'
