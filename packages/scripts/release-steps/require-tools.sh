#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
missing=()
for tool in $TOOLS; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "$tool: $(command -v "$tool")"
  else
    missing+=("$tool")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error title=Runner is missing release tools::$(hostname) (${RUNNER_NAME:-unknown runner}) has no ${missing[*]} on PATH. Install them on this runner or take it out of the pool; nothing was released." >&2
  exit 1
fi
;;
*) echo "Unknown require-tools step: $1" >&2; exit 2 ;;
esac
