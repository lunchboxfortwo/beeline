#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
node scripts/pages-site.mjs build --static-only --output-dir "$RUNNER_TEMP/usebeeline-pages"
;;
*) echo "Unknown pages-leg step: $1" >&2; exit 2 ;;
esac
