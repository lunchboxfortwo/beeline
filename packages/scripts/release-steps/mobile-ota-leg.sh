#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
bash ../../packages/scripts/npm-ci-timed.sh
npm run eas-build-post-install
;;
step1)
set -euo pipefail
if [ -n "$EXPO_TOKEN_SECRET" ]; then export EXPO_TOKEN="$EXPO_TOKEN_SECRET"; fi
mkdir -p "$RUNNER_TEMP/ota"
memory="${OTA_MEMORY:-}"
[ -n "$memory" ] || memory='{}'
export OTA_MEMORY="$memory"
node ../../packages/scripts/release-job-output.mjs OTA_MEMORY "$RUNNER_TEMP/ota/memory.json"
node scripts/ota-release.mjs targets --memory "$RUNNER_TEMP/ota/memory.json" --output "$RUNNER_TEMP/ota/targets.json"
;;
publish)
set -euo pipefail
if [ -n "$EXPO_TOKEN_SECRET" ]; then export EXPO_TOKEN="$EXPO_TOKEN_SECRET"; fi
test -n "${EXPO_TOKEN:-}" || { echo "EXPO_TOKEN is unavailable" >&2; exit 2; }
started="$(date +%s)"
OTA_TMPDIR="$(mktemp -d)"
TMPDIR="$OTA_TMPDIR" node scripts/ota-release.mjs publish \
  --sha "$RELEASE_SHA" --release-version "$RELEASE_VERSION" --branch "$BRANCH" \
  --channel "$CHANNEL" --targets "$RUNNER_TEMP/ota/targets.json" \
  --output "$RUNNER_TEMP/ota/published.json"
echo "OTA branch publish: $(( $(date +%s) - started ))s" >> "$GITHUB_STEP_SUMMARY"
;;
facts)
node --input-type=module - "$RUNNER_TEMP/ota" >> "$GITHUB_OUTPUT" <<'NODE'
import { readFileSync } from 'node:fs';
import { encodeReleaseOutput } from '../../packages/scripts/release-job-output.mjs';
const facts = JSON.parse(readFileSync(`${process.argv[2]}/published.json`, 'utf8'));
console.log(`branch=${facts.branch}`);
console.log(`targets=${facts.targets.map(t => `${t.platform}@${t.runtimeVersion}`).join(',')}`);
if (facts.storeRuntime) console.log(`store_runtime=${encodeReleaseOutput({ previouslyLive: facts.storeRuntime.previouslyLive ?? [] })}`);
console.log(`completed_at=${Math.floor(Date.now() / 1000)}`);
NODE
;;
*) echo "Unknown mobile-ota-leg step: $1" >&2; exit 2 ;;
esac
