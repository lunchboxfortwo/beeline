#!/usr/bin/env bash
# Shared release steps; the composite action owns ordering, conditions and inputs.
set -euo pipefail
case "${1:?expected release step name}" in
step0)
bash ../../packages/scripts/npm-ci-timed.sh
;;
step1)
npx expo export --platform web --source-maps --output-dir dist
;;
step2)
node scripts/prepare-web-sourcemaps.mjs dist "$RELEASE_SHA"
;;
step3)
cmp apps/mobile/public/push-sw.js apps/mobile/dist/push-sw.js
;;
step4)
node -e 'require("node:fs").writeFileSync("apps/mobile/dist/beeline-web-release.json", JSON.stringify({version:process.env.RELEASE_VERSION,sourceSha:process.env.RELEASE_SHA})+"\n")'
;;
step5)
"$EAS_CLI_PATH" deploy --prod --export-dir dist --non-interactive
;;
step6)
node packages/scripts/verify-web-deployment.mjs --expected-release apps/mobile/dist/beeline-web-release.json --attempts 20
;;
*) echo "Unknown web-app-leg step: $1" >&2; exit 2 ;;
esac
