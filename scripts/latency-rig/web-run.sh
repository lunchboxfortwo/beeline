#!/usr/bin/env bash
# Independent web inventory lane; never starts or claims an Android emulator.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_dir"
node --test scripts/latency-rig/nightly-web-capture.test.mjs scripts/latency-rig/check-routes.test.mjs scripts/latency-rig/web-route-fixtures.test.mjs
node scripts/latency-rig/check-routes.mjs
run_dir="$(realpath -m "${1:?output directory required}")"
mkdir -p "$run_dir"
export LATENCY_RIG_DATABASE_URL="${LATENCY_RIG_WEB_DATABASE_URL:-postgresql://localhost/beeline_latency_rig_inventory?host=%2Fvar%2Frun%2Fpostgresql}"
export LATENCY_RIG_SERVER_PORT="${LATENCY_RIG_WEB_SERVER_PORT:-18090}"
export LATENCY_RIG_PORT="${LATENCY_RIG_WEB_PROXY_PORT:-18091}"
export LATENCY_RIG_WEB_PORT="${LATENCY_RIG_WEB_PORT:-18089}"
export LATENCY_RIG_OBJECT_PORT="${LATENCY_RIG_WEB_OBJECT_PORT:-18092}"
export LATENCY_RIG_WEB_ROUTES="${LATENCY_RIG_WEB_ROUTES:-1}"
# Synthetic credentials authorize only the disposable loopback storage fixture.
export AWS_ACCESS_KEY_ID=latency-local-fake
export AWS_SECRET_ACCESS_KEY=latency-local-fake
export BUCKET_NAME=latency-rig
export AWS_ENDPOINT_URL_S3="http://127.0.0.1:$LATENCY_RIG_OBJECT_PORT"
export LATENCY_RIG_WEB_BACKEND="http://127.0.0.1:$LATENCY_RIG_SERVER_PORT"
export LATENCY_RIG_WEB_ORIGIN="http://127.0.0.1:$LATENCY_RIG_WEB_PORT"
export LATENCY_RIG_REVIEW_SECRET=latency-fixture-local-only-web-inventory
export LATENCY_RIG_SQL_LOG="$run_dir/sql.ndjson"
export LATENCY_RIG_PROXY_LOG="$run_dir/proxy.ndjson"
# Validate database authority before psql/createdb as well as before seeding.
node --input-type=module <<'JS'
const url=new URL(process.env.LATENCY_RIG_DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.includes('latency_rig')||
(url.searchParams.has('host')&&url.searchParams.get('host')!=='/var/run/postgresql'))throw new Error('Web rig requires a loopback latency_rig database');
JS
if ! psql "$LATENCY_RIG_DATABASE_URL" -Atqc 'SELECT 1' >/dev/null 2>&1; then
  createdb --maintenance-db="$(node -e 'let u=new URL(process.env.LATENCY_RIG_DATABASE_URL);u.pathname="/postgres";console.log(u.href)')" "$(node -e 'console.log(new URL(process.env.LATENCY_RIG_DATABASE_URL).pathname.slice(1))')"
fi
node --input-type=module <<'JS'
import { createServer } from 'node:net';
for(const port of [process.env.LATENCY_RIG_SERVER_PORT,process.env.LATENCY_RIG_PORT,process.env.LATENCY_RIG_WEB_PORT,process.env.LATENCY_RIG_OBJECT_PORT]){
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(port),'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));
}
JS
server_pid=""
web_pid=""
object_pid=""
cleanup() {
  [[ -z "$object_pid" ]] || kill "$object_pid" 2>/dev/null || true
  [[ -z "$object_pid" ]] || wait "$object_pid" 2>/dev/null || true
  [[ -z "$web_pid" ]] || kill "$web_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
  [[ -z "$web_pid" ]] || wait "$web_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
node scripts/latency-rig/local-object-store.mjs &
object_pid=$!
(cd apps/mobile && EXPO_PUBLIC_BUZZY_MONOLITH_URL="$LATENCY_RIG_WEB_BACKEND" \
  ./node_modules/.bin/expo export --platform web --clear --max-workers 2 --output-dir "$run_dir/build") >"$run_dir/build.log" 2>&1
bash scripts/latency-rig/run-local.sh >"$run_dir/server.log" 2>&1 &
server_pid=$!
node scripts/latency-rig/web-serve.mjs "$run_dir/build" &
web_pid=$!
for _ in {1..90}; do
  kill -0 "$server_pid" || { cat "$run_dir/server.log"; exit 1; }
  if rg -q '^Local rig ready\.' "$run_dir/server.log" &&
    [[ "$(lsof -t -nP -iTCP:"$LATENCY_RIG_WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)" == "$web_pid" ]] &&
    curl -fsS "$LATENCY_RIG_WEB_BACKEND/healthz" >/dev/null &&
    curl -fsS "$LATENCY_RIG_WEB_ORIGIN" >/dev/null; then break; fi
  sleep 1
done
node scripts/latency-rig/web-capture.mjs "$run_dir"
