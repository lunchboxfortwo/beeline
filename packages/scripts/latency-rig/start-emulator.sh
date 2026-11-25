#!/usr/bin/env bash
# Start a worktree-owned emulator, leaving other lanes' devices alone.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export ANDROID_HOME="${ANDROID_HOME:-/home/lunchbox/android-sdk}"
avd_name=beeline-latency-pixel5
port="${LATENCY_RIG_EMULATOR_PORT:-5580}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 5554 || port > 5680 || port % 2 != 0 )); then
  echo 'LATENCY_RIG_EMULATOR_PORT must be an even Android emulator port from 5554 to 5680' >&2
  exit 2
fi
serial="emulator-$port"
read -r checkout_key _ < <(printf '%s' "$repo_dir" | sha256sum)
unit="beeline-latency-${checkout_key:0:16}-$port.scope"
if adb devices | awk 'NR > 1 {print $1}' | grep -Fxq "$serial"; then
  if systemctl --user is-active --quiet "$unit"; then
    echo "$serial is already running"
    exit 0
  fi
  echo "$serial is already in use by another job" >&2
  exit 2
fi
# This runner's 200% quota is a stable scenario, not a device equivalence.
# The 46% Geekbench single-core score ratio made Android System UI unresponsive.
# A different host must set an explicitly measured quota.
cpu_quota="${LATENCY_RIG_CPU_QUOTA_PERCENT:-}"
if [[ -z "$cpu_quota" ]]; then
  if grep -q 'Intel(R) Core(TM) i9-10900K' /proc/cpuinfo; then
    cpu_quota=200
  else
    echo 'Set LATENCY_RIG_CPU_QUOTA_PERCENT after calibrating this host' >&2
    exit 2
  fi
fi
if ! [[ "$cpu_quota" =~ ^[0-9]+$ ]] || (( cpu_quota < 10 || cpu_quota > 1000 )); then
  echo 'LATENCY_RIG_CPU_QUOTA_PERCENT must be an integer from 10 to 1000' >&2
  exit 2
fi
scratch="$(mktemp -d "${LATENCY_RIG_SCRATCH_ROOT:-${TMPDIR:-/tmp}}/beeline-emulator.XXXXXX")"
emulator_pid=""
# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup() {
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export ANDROID_USER_HOME="$scratch/android" ANDROID_EMULATOR_HOME="$scratch/android"
export ANDROID_AVD_HOME="$scratch/avd" TMPDIR="$scratch"
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name "$avd_name" --package 'system-images;android-35;google_apis;x86_64' \
  --device pixel_5 --path "$ANDROID_AVD_HOME/$avd_name.avd"
echo "Starting $serial (job AVD $ANDROID_AVD_HOME/$avd_name.avd)"
# The job owns the launcher and waits for it before releasing its scratch.
systemd-run --user --scope --quiet --unit="$unit" -p "CPUQuota=${cpu_quota}%" \
  "$ANDROID_HOME/emulator/emulator" -avd "$avd_name" -port "$port" \
  -no-window -no-snapshot -no-audio -gpu swiftshader_indirect \
  >"$scratch/emulator.log" 2>&1 &
emulator_pid=$!
status=0
wait "$emulator_pid" || status=$?
emulator_pid=""
if (( status != 0 )); then tail -n 60 "$scratch/emulator.log" >&2; fi
exit "$status"
