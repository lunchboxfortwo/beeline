import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('packages/scripts/server-release-image.sh');
const sha = 'a'.repeat(40), version = 'v1.2.3';
const image = `registry.fly.io/beeline-free-agents:1.2.3-${sha.slice(0, 12)}@sha256:${'b'.repeat(64)}`;
for (const prebuilt of [true, false]) test(`pins the matching starter image in a ${prebuilt ? 'prebuilt' : 'source-built'} server`, () => {
  const root = mkdtempSync(join(tmpdir(), 'server-image-binding-'));
  try {
    mkdirSync(join(root, 'bin'));
    const shim = (name, body) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    shim('git', 'printf "%s\\n" "$TEST_SHA"');
    shim('flyctl', 'printf "%s\\n" "$*" >> "$TEST_CALLS"');
    shim('docker', `printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  'pull registry.fly.io/beeline-server:source-'*) [ "$TEST_PREBUILT" = true ] || exit 1 ;;
  'image inspect')
    case "$*" in
      *app.usebeeline.release.sha*) printf '%s\\n' "$TEST_SHA" ;;
      *RepoDigests*) printf '%s\\n' 'registry.fly.io/beeline-server@sha256:${'c'.repeat(64)}' ;;
    esac ;;
  'build '*) cat > "$TEST_DOCKERFILE" ;;
esac`);
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, IMAGE_REF: image,
      TEST_SHA: sha, TEST_PREBUILT: String(prebuilt), TEST_CALLS: join(root, 'calls'), TEST_DOCKERFILE: join(root, 'Dockerfile') };
    execFileSync('bash', [script, 'release', sha, version], { cwd: root, env, stdio: 'pipe' });
    const calls = readFileSync(env.TEST_CALLS, 'utf8');
    if (prebuilt) {
      const dockerfile = readFileSync(env.TEST_DOCKERFILE, 'utf8');
      assert.ok(dockerfile.includes(`JSON.stringify({image:"${image}"})`));
      assert.ok(dockerfile.includes('apps/server/assets/free-agent-image.json'));
    } else assert.ok(calls.includes(`--build-arg BEELINE_FREE_AGENT_IMAGE=${image}`));
    assert.ok(!calls.includes('secrets set'));
    assert.throws(() => execFileSync('bash', [script, 'release', sha, version], {
      cwd: root, env: { ...env, IMAGE_REF: image.replace('1.2.3-', '1.2.2-') }, stdio: 'pipe',
    }), /Command failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Squire builds a local source image, binds its image ID and pushes only the release tag', () => {
  const root = mkdtempSync(join(tmpdir(), 'server-image-local-'));
  try {
    const id = `sha256:${'c'.repeat(64)}`;
    const label = `1.2.3-${sha.slice(0, 12)}`;
    const shim = (name, body) => writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    shim('git', 'printf "%s\\n" "$TEST_SHA"');
    shim('flyctl', 'printf "flyctl %s\\n" "$*" >> "$TEST_CALLS"');
    shim('docker', `printf 'docker %s\\n' "$*" >> "$TEST_CALLS"
case "$1 $2" in
  'image inspect')
    case "$*" in
      *app.usebeeline.release.sha*) printf '%s\\n' "$SOURCE_SHA" ;;
      *'{{.Id}}'*) printf '%s\\n' '${id}' ;;
      *) test -f "$TEST_LOCAL_IMAGE" ;;
    esac ;;
  'build --file') touch "$TEST_LOCAL_IMAGE" ;;
  'build --pull=false') cat > "$TEST_DOCKERFILE" ;;
esac`);
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, IMAGE_REF: image, TEST_SHA: sha, SOURCE_SHA: sha,
      TEST_CALLS: join(root, 'calls'), TEST_LOCAL_IMAGE: join(root, 'source'), TEST_DOCKERFILE: join(root, 'Dockerfile') };
    const run = (mode, overrides = {}) => execFileSync('bash', [script, mode, sha, version],
      { cwd: root, env: { ...env, ...overrides }, stdio: 'pipe' });

    run('prepare-local');
    run('prepare-local');
    assert.throws(() => run('build-local', { SOURCE_SHA: 'd'.repeat(40) }), /source SHA mismatch/);
    run('build-local');
    assert.ok(readFileSync(env.TEST_DOCKERFILE, 'utf8').startsWith(`FROM ${id}\n`));
    assert.ok(readFileSync(env.TEST_DOCKERFILE, 'utf8').includes(image));
    const calls = () => readFileSync(env.TEST_CALLS, 'utf8').trim().split('\n');
    assert.equal(calls().filter(line => line.startsWith('docker build --file')).length, 1);
    assert.ok(!calls().some(line => /^(flyctl|docker (push|pull)) /.test(line)));

    run('push-local');
    assert.deepEqual(calls().slice(-2), ['flyctl auth docker', `docker push registry.fly.io/beeline-server:${label}`]);

    rmSync(env.TEST_LOCAL_IMAGE);
    run('build-local');
    assert.match(calls().at(-1), /docker build --file apps\/server\/Dockerfile/);
    assert.ok(calls().at(-1).includes(`--build-arg BEELINE_FREE_AGENT_IMAGE=${image}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
