import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  RELEASE_COMPONENTS,
  changedPathsFromPublishedInputs,
  initializeRelease,
  planOutputs,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
} from './unified-release.mjs';

const previousSha = 'a'.repeat(40);
const releaseSha = 'b'.repeat(40);
const componentPaths = (paths = []) => Object.fromEntries(RELEASE_COMPONENTS.map(component => [component, paths]));
const publishedRelease = () => {
  const previous = initializeRelease({ version: 'v0.1.162', sourceSha: previousSha });
  previous.state = 'delivered';
  for (const entry of Object.values(previous.components)) entry.state = 'checked';
  return previous;
};

for (const path of [
  'apps/mobile/sources/components/buzz/room-list-row.ts',
  'apps/mobile/assets/icon.png',
  'packages/api-contract/src/index.ts',
  'packages/buzz-client/src/index.ts',
  'packages/nostr/src/index.ts',
  'packages/net/src/route-codecs.ts',
  'apps/mobile/index.ts',
  'apps/mobile/metro.config.js',
  'apps/mobile/babel.config.js',
  'apps/mobile/public/canvaskit.wasm',
  'apps/mobile/patches/@expo+vector-icons+15.1.1.patch',
  'apps/mobile/scripts/patch-livekit-abort.cjs',
  'apps/mobile/scripts/patch-livekit-owned.cjs',
  'package.json',
  'package-lock.json',
  'packages/scripts/tsconfig.base.json',
  'apps/mobile/app.config.js',
  'apps/mobile/package.json',
  'apps/mobile/package-lock.json',
  'apps/mobile/src-tauri/src/lib.rs',
  'apps/mobile/src-tauri/Cargo.lock',
  'apps/mobile/src-tauri/tauri.conf.json',
]) {
  test(`desktop rebuilds immediately for its bundled input: ${path}`, () => {
    assert.ok(selectReleaseComponents([path]).includes('desktop'));
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths([path]));
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=true$/m);
    assert.equal(state.components.desktop.sourceSha, releaseSha);
    assert.notEqual(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
  });
}

for (const paths of [[], ['apps/server/src/index.ts'], ['apps/site/index.html']]) {
  test(`desktop carries its published build when bundled inputs are unchanged: ${JSON.stringify(paths)}`, () => {
    const previous = publishedRelease();
    const selectedComponents = selectReleaseComponentsFromPublishedInputs(componentPaths(paths));
    assert.equal(selectedComponents.includes('desktop'), false);
    const state = initializeRelease({ version: 'v0.1.163', sourceSha: releaseSha, previous, selectedComponents });
    assert.match(planOutputs(state, previous), /^run_desktop=false$/m);
    assert.equal(state.components.desktop.sourceSha, previous.components.desktop.sourceSha);
    assert.equal(state.components.desktop.artifactRef, previous.components.desktop.artifactRef);
    assert.equal(state.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
    if (paths[0]?.startsWith('apps/server/')) assert.deepEqual(selectedComponents, ['server']);
  });
}

test('desktop compares against its own published source even when the other components are current', () => {
  const previous = publishedRelease();
  previous.sourceSha = releaseSha;
  for (const [component, entry] of Object.entries(previous.components)) {
    if (component !== 'desktop') entry.sourceSha = releaseSha;
  }
  const paths = changedPathsFromPublishedInputs(previous, releaseSha, {
    gitDiff: publishedSha => publishedSha === previousSha ? 'apps/mobile/sources/app/index.tsx\n' : '',
  });
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths), ['desktop']);
});

test('explicit recovery selection still controls which components rebuild', () => {
  const paths = componentPaths(['apps/mobile/sources/app/index.tsx']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(paths, { selection: 'server' }), ['server']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(componentPaths(), { selection: 'desktop' }), ['desktop']);
});

// The free-agent image must use the release's existing rollout; publishing
// after completion used to restart every server a second time and drop phones.
test('free-agent image publication bakes its digest into the sole server rollout', () => {
  assert.equal(existsSync('.github/workflows/free-agent-image.yml'), false);
  const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));
  const steps = parse(readFileSync('.github/actions/server-leg/action.yml', 'utf8')).runs.steps;
  const shared = readFileSync('packages/scripts/release-steps/server-leg.sh', 'utf8');
  for (const step of steps) if (step.run) {
    const key = step.run.split(' ').at(-1);
    const body = shared.match(new RegExp(`^${key}\\)\\n([\\s\\S]*?)^;;$`, 'm'));
    assert.ok(body, `shared server step ${key} exists`);
    step.run = body[1];
  }
  const publish = steps.findIndex(step => step.id === 'free_agent_image');
  const build = steps.findIndex(step => step.name?.startsWith('Build the exact Fly image'));
  const rollout = steps.findIndex(step => step.name?.startsWith('Canary one Machine'));
  const verify = steps.findIndex(step => step.name?.startsWith('Verify the free starter image'));
  assert.ok(publish < build && build < rollout && rollout < verify);
  for (const index of [publish, build]) assert.equal(steps[index].if, "steps.fleet.outputs.shipped != 'true'");
  assert.equal(steps[verify].if, undefined, 'a shipped server must not hide a failed helper refresh on rerun');
  const updates = steps.filter(step => /--strategy bluegreen/.test(step.run ?? ''));
  assert.equal(updates.length, 1);
  assert.equal(updates[0], steps[rollout]);
  assert.match(steps[publish].run, /--build-only --push/);
  const call = workflow.jobs.server.steps.find(step => step.uses === './.github/actions/server-leg');
  assert.equal(call.with.free_agent_image_token, '${{ secrets.FLY_FREE_AGENT_IMAGE_TOKEN }}');

  const root = mkdtempSync(join(tmpdir(), 'beeline-image-stage-'));
  try {
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'packages/scripts'), { recursive: true });
    writeFileSync(join(root, 'packages/scripts/stage-free-agent-helper.sh'), 'exit 0\n');
    const image = `registry.fly.io/beeline-free-agents:1.2.3-${releaseSha.slice(0, 12)}@sha256:${'c'.repeat(64)}`;
    writeFileSync(join(root, 'bin/docker'), `#!/bin/sh\nprintf '%s\\n' '{"Descriptor":{"digest":"sha256:${'c'.repeat(64)}"}}'\n`, { mode: 0o755 });
    writeFileSync(join(root, 'bin/flyctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'machine list') printf '%s\\n' '[{"id":"one","state":"started"},{"id":"two","state":"started"}]' ;;
  'machine exec')
    if [ "$6" != '--json' ]; then
      printf '%s\\n' "\${ACTUAL_IMAGE:-$IMAGE_REF}"
    else
      # Model Fly's independent remote and local exit codes, including omitempty.
      printf '%s\\n' "$EXEC_RESULT"
      exit "\${FLY_EXIT:-0}"
    fi ;;
esac
`, { mode: 0o755 });
    const output = join(root, 'output');
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root,
      RELEASE_SHA: releaseSha, RELEASE_VERSION: 'v1.2.3', GITHUB_OUTPUT: output,
      IMAGE_REF: image, EXEC_RESULT: '{"stdout":"refreshed"}', CALLS: join(root, 'calls') };
    execFileSync('bash', ['-c', steps[publish].run], { cwd: root, env });
    assert.equal(readFileSync(output, 'utf8').trim(), `image_ref=${image}`);
    assert.equal(steps[build].env.IMAGE_REF, '${{ steps.free_agent_image.outputs.image_ref }}');
    mkdirSync(join(root, 'server-release'));
    execFileSync('bash', ['-c', steps[verify].run], { cwd: root, env });
    const calls = readFileSync(env.CALLS, 'utf8');
    assert.equal(calls.includes('secrets set'), false);
    assert.equal(calls.includes('machine update'), false);
    assert.match(calls, /machine exec one --app beeline-server node -p.*free-agent-image\.json/);
    assert.match(calls, /machine exec two --app beeline-server node -p.*free-agent-image\.json/);
    assert.match(calls, /--refresh-free-agents/);
    assert.match(calls, /machine exec one --app beeline-server --json --timeout 120 node \/app\/apps\/server\/dist\/index.js --refresh-free-agents/);
    // The command must work without Docker's /app WORKDIR, and remote failures
    // must fail the release even when flyctl reports local success.
    for (const receipt of ['{"exit_code":1,"stderr":"MODULE_NOT_FOUND"}',
      '{"exit_code":1,"stderr":"Free-agent image refresh failed: one Machine refused"}', 'not-json', 'null']) {
      assert.throws(() => execFileSync('bash', ['-c', steps[verify].run], {
        cwd: root, env: { ...env, EXEC_RESULT: receipt }, stdio: 'pipe',
      }), /Command failed/);
    }
    assert.throws(() => execFileSync('bash', ['-c', steps[verify].run], {
      cwd: root, env: { ...env, FLY_EXIT: '1', EXEC_RESULT: '{}' }, stdio: 'pipe',
    }), /Command failed/);
    execFileSync('bash', ['-c', steps[verify].run], {
      cwd: root, env: { ...env, IMAGE_REF: '', ACTUAL_IMAGE: image, EXEC_RESULT: '{"exit_code":0}' },
    });
    assert.throws(() => execFileSync('bash', ['-c', steps[verify].run], {
      cwd: root, env: { ...env, ACTUAL_IMAGE: 'older-image' }, stdio: 'pipe',
    }), /Command failed/);
    assert.equal(readFileSync(env.CALLS, 'utf8').includes('machine update'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Beebee, 2026-11-18: a released server shipped while every free-agent turn
// failed. The server leg now requires a real reply from the review Workspace.
test('the server leg ends by requiring a real free-agent reply in the review proof Workspace', () => {
  const steps = parse(readFileSync('.github/actions/server-leg/action.yml', 'utf8')).runs.steps;
  const verify = steps.findIndex(step => step.name?.startsWith('Verify the free starter image'));
  const reply = steps.findIndex(step => step.name?.startsWith('Require a real free-agent reply'));
  assert.equal(reply, steps.length - 1);
  assert.ok(verify < reply);
  assert.equal(steps[reply].if, undefined, 'a shipped server rerun still proves a reply');
  assert.match(readFileSync('packages/scripts/release-steps/server-leg.sh', 'utf8'),
    /^free_agent_reply\)\n[\s\S]*?free-agent-reply-proof\.mjs[\s\S]*?^;;$/m);
});

for (const outcome of ['reply', 'failure']) test(`the free-agent reply proof ${outcome === 'reply' ? 'passes on' : 'fails on'} a ${outcome}`, async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { spawn } = await import('node:child_process');
  const agent = 'bb35cda30e5bcda7bb15d78fe2def34ecc9e2a389f5c455fad8e657b2d0aa4a6';
  const room = '79237f38-5214-47ef-b1ef-7bd8ad035d3a';
  let socket, tagged;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/auth/review/exchange') return response.end(JSON.stringify({ accessToken: 'synthetic-token' }));
    if (request.url === '/v1/phone/operations/sendRoomMessage') {
      tagged = JSON.parse(body); response.end('{}');
      socket.send(JSON.stringify({ type: 'message-delta', roomId: room, message: { id: 'reply', requestId: tagged.messageId,
        author: { pubkey: agent }, presentation: outcome === 'reply' ? 'message' : 'system',
        text: outcome === 'reply' ? 'Hello from Beebee.' : '@beebee_26 failed · Model request did not complete' } }));
      return;
    }
    response.statusCode = 404; response.end('{}');
  });
  const live = new WebSocketServer({ server, path: '/v1/phone/live' });
  live.on('connection', (client, request) => {
    assert.equal(request.headers['sec-websocket-protocol'], 'bearer.synthetic-token');
    socket = client;
    client.on('message', raw => {
      const frame = JSON.parse(String(raw));
      assert.deepEqual(frame, { type: 'subscribe', roomId: room, roomStateProjections: true });
      client.send(JSON.stringify({ type: 'subscribed', roomId: room }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['packages/scripts/release-steps/free-agent-reply-proof.mjs'], {
      env: { PATH: process.env.PATH, SERVER_CANARY_REVIEW_SECRET: 'synthetic-secret',
        BEELINE_PROOF_ORIGIN: `http://127.0.0.1:${server.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(tagged.roomId, room);
    assert.match(tagged.text, /^@beebee_26 /);
    if (outcome === 'reply') { assert.equal(code, 0, output); assert.match(output, /answered the release proof/); }
    else { assert.notEqual(code, 0); assert.match(output, /Free agent turn failed: .*Model request did not complete/); }
  } finally { for (const client of live.clients) client.terminate(); live.close(); server.close(); }
});
