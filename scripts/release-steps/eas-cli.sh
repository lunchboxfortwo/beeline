#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
set -euo pipefail
bash scripts/npm-ci-timed.sh --prefix tools/eas-cli
echo "EAS_CLI_PATH=$GITHUB_WORKSPACE/tools/eas-cli/node_modules/.bin/eas" >> "$GITHUB_ENV"
;;
*) echo "Unknown eas-cli step: $1" >&2; exit 2 ;;
esac
