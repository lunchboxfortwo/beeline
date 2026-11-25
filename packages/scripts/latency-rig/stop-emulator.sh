#!/usr/bin/env bash
# Stop only the worktree's dedicated emulator.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
port="${LATENCY_RIG_EMULATOR_PORT:-5580}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 5554 || port > 5680 || port % 2 != 0 )); then
  echo 'LATENCY_RIG_EMULATOR_PORT must be an even Android emulator port from 5554 to 5680' >&2
  exit 2
fi
read -r checkout_key _ < <(printf '%s' "$repo_dir" | sha256sum)
unit="beeline-latency-${checkout_key:0:16}-$port.scope"
if ! systemctl --user is-active --quiet "$unit"; then
  echo 'No worktree-owned emulator scope is running' >&2
  exit 2
fi
systemctl --user stop "$unit"
echo "Stopped emulator-$port"
