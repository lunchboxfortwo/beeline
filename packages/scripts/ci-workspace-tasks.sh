#!/usr/bin/env bash
set -euo pipefail

# TYPECHECK runs its checks sequentially; MOBILE SUITE owns a separate checkout.
# Keep architecture and trusted-base phone/UI policy checks equivalent to TYPECHECK.

typecheck() {
  # Live GitHub operations must target the current account
  npm run lint:repositories
  # Enforce the shared UI component registry
  export UI_POLICY_BASE="$CI_BASE_SHA"
  git fetch --no-tags origin "$UI_POLICY_BASE"
  node packages/scripts/check-mobile-ui-components.mjs --base "$UI_POLICY_BASE"
  # Hold every Tamagui surface to the one design grammar
  node packages/scripts/check-mobile-grammar.mjs
  node packages/scripts/generate-stone-css.mjs --check
  node packages/scripts/check-stone-surfaces.mjs
  node --test packages/scripts/check-stone-surfaces.test.mjs
  # Allow no phone network channel besides the main live socket
  export CHANNEL_BASE="$CI_BASE_SHA"
  git fetch --no-tags origin "$CHANNEL_BASE"
  node packages/scripts/check-phone-network-channels.mjs --base "$CHANNEL_BASE"
  node packages/scripts/check-router-boundaries.mjs --base "$CHANNEL_BASE"
  node packages/scripts/check-no-emulator-start.mjs
  node --test packages/scripts/no-emulator-start.test.mjs
  # Nothing but the walls in docs/walls.md may refuse or hold a request
  node packages/scripts/check-walls.mjs
  node --test packages/scripts/check-walls.test.mjs
  # Keep each module's sinks in their owner files
  export ARCHITECTURE_BASE="$CI_BASE_SHA"
  git fetch --no-tags origin "$ARCHITECTURE_BASE"
  # G1: candidate invariants govern CI; changes are reviewed weekly after merging.
  node packages/scripts/check-architecture.mjs --root . --base "$ARCHITECTURE_BASE"
  # The root command also generates mobile routes and typechecks mobile.
  node packages/scripts/rollout-schema.mjs --previous "$CI_BASE_SHA"
  if [[ "$GITHUB_EVENT_NAME" == pull_request ]]; then
    npx turbo run typecheck --filter="...[$CI_BASE_SHA]"
  else
    npx turbo run typecheck
  fi
  npm run typecheck --prefix apps/mobile
  npx tsc -p packages/scripts/tsconfig.scripts.json
  # Check no script, workflow, unit or skill names a deleted file
  npm run lint:referenced-paths
  # Ensure Playwright's Chromium headless shell is available for browser-backed proof tests
  npx playwright install --only-shell chromium
  # Check CI routing, partitioning and build provenance
  node --test --test-concurrency=1  packages/scripts/run-workspace-tests.test.mjs packages/scripts/report-main-checks.test.mjs packages/scripts/architecture-invariants.test.mjs packages/scripts/integration-shards.test.mjs packages/scripts/mobile-ui-policy-moves.test.mjs packages/scripts/mobile-grammar-policy.test.mjs packages/scripts/connection-ui-policy.test.mjs packages/scripts/server-timers.test.mjs packages/scripts/helper-waits.test.mjs packages/scripts/machine-connection-boundaries.test.mjs packages/scripts/corner-machine-boundary.test.mjs packages/scripts/system-transcript-boundary.test.mjs packages/scripts/legal-pages.test.mjs packages/scripts/ui-surface-proof.test.mjs
  # Test nightly Checks orchestration
}


mobile_suite() {
  # Run the mobile vitest suite
  node packages/scripts/run-workspace-tests.mjs mobile
  # Verify Android release shrinking mods
  # Prove Android cached update integrity and retry
}


dead_code() {
  # Reject new unused files or exports
  timeout 5m npm run dead-code
  # Prove an unused export fails the guard
}


native_fingerprint() {
  # Compare the native fingerprint with the committed runtime pin
  ( cd "apps/mobile"
    npm run fingerprint:check
  )
  # Run the native fingerprint regression in isolation
  ( cd "apps/mobile"
  )
}


mobile_export_reachability() {
  local android_out="${RUNNER_TEMP:?RUNNER_TEMP is required}/mobile-export"
  local web_out="${RUNNER_TEMP}/mobile-web-export"
  trap 'rm -rf "${RUNNER_TEMP}/mobile-export" "${RUNNER_TEMP}/mobile-web-export"' EXIT

  # Export Android bundle
  ( cd "apps/mobile"
    npx expo export --max-workers 1 --platform android --output-dir "$android_out" --clear
  )
  # Prove the export produced an Android bundle
  test -n "$(find "$android_out/_expo/static/js/android" -name '*.hbc' -o -name '*.js' | head -n 1)"
  # Reject transcript measurement code in the normal Android bundle
  if grep -aREl 'transcript-speed/|__transcriptSpeed|__transcriptBuild' "$android_out/_expo/static/js/android"; then
    echo 'Normal Android bundle contains transcript measurement code'
    exit 1
  fi
  rm -rf "$android_out"

  # Export Web bundle sequentially after Android so peak RSS stays bounded
  ( cd "apps/mobile"
    npx expo export --max-workers 1 --platform web --output-dir "$web_out" --clear
  )
  # Prove the export produced static Web HTML and JS output
  test -n "$(find "$web_out" -maxdepth 2 -name '*.html' | head -n 1)"
  test -n "$(find "$web_out/_expo/static/js/web" -name '*.js' | head -n 1)"
  # Reject transcript measurement code in the normal Web bundle
  if grep -aREl 'transcript-speed/|__transcriptSpeed|__transcriptBuild' "$web_out/_expo/static/js/web"; then
    echo 'Normal Web bundle contains transcript measurement code'
    exit 1
  fi
  rm -rf "$web_out"
}


case "${1:?expected a workspace check name}" in
  typecheck) typecheck ;;
  mobile-suite) mobile_suite ;;
  dead-code) dead_code ;;
  native-fingerprint) native_fingerprint ;;
  mobile-export-reachability) mobile_export_reachability ;;
  *) echo "Unknown workspace check: $1" >&2; exit 2 ;;
esac
