#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
linux_dir="${BEELINE_ACTION_VALUE_0}"
arm64_dir="${BEELINE_ACTION_VALUE_1}"
x64_dir="${BEELINE_ACTION_VALUE_2}"
if [ -z "$linux_dir" ] || { [ -z "$arm64_dir" ] && [ -z "${BEELINE_RELEASE_CARRIED_ARM64_DIR:-}" ]; } || { [ -z "$x64_dir" ] && [ -z "${BEELINE_RELEASE_CARRIED_X64_DIR:-}" ]; }; then
  echo "A three-platform merge needs linux_bundle_dir, darwin_arm64_bundle_dir and darwin_x64_bundle_dir; the Mac bundles were never built this run." >&2
  exit 1
fi
merge_args=(--output-dir "$RUNNER_TEMP/daemon-release" --input-dir "$linux_dir")
if [ -n "${BEELINE_RELEASE_CARRIED_ARM64_DIR:-}" ]; then
  merge_args+=(--carry-arm64-dir "$BEELINE_RELEASE_CARRIED_ARM64_DIR")
else
  merge_args+=(--input-dir "$arm64_dir")
fi
if [ -n "${BEELINE_RELEASE_CARRIED_X64_DIR:-}" ]; then
  merge_args+=(--carry-x64-dir "$BEELINE_RELEASE_CARRIED_X64_DIR")
else
  merge_args+=(--input-dir "$x64_dir")
fi
node scripts/merge-beeline-bundles.mjs "${merge_args[@]}"
if [ -f "$arm64_dir/mac-helper-inputs.json" ]; then
  cp "$arm64_dir/mac-helper-inputs.json" "$RUNNER_TEMP/daemon-release/mac-helper-inputs-darwin-arm64.json"
fi
if [ -f "$x64_dir/mac-helper-inputs.json" ]; then
  cp "$x64_dir/mac-helper-inputs.json" "$RUNNER_TEMP/daemon-release/mac-helper-inputs-darwin-x64.json"
fi
;;
step2)
node scripts/verify-pages-update.mjs --manifest-url "$MANIFEST_URL" --expected-manifest "${BEELINE_ACTION_VALUE_0}/daemon-release/manifest.json" --work-dir "$RUNNER_TEMP/helper-update-proof"
;;
step3)
set -u
{
  echo '## Helper fleet uptake (asynchronous)'
  echo
  if curl -fsS --max-time 10 \
    https://server.usebeeline.app/v1/releases/daemon-readiness \
    -o "$RUNNER_TEMP/release-readiness.json"; then
    echo '```json'
    cat "$RUNNER_TEMP/release-readiness.json"
    echo
    echo '```'
  else
    echo 'Readiness snapshot unavailable. Fleet convergence remains post-release observability.'
  fi
} >> "$GITHUB_STEP_SUMMARY"
;;
*) echo "Unknown daemon-leg step: $1" >&2; exit 2 ;;
esac
