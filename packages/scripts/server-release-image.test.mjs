import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('hosted prebuild and no-prebuilt release resolve the server Dockerfile outside apps/infra', () => {
  const flyConfigPath = 'apps/infra/fly.beeline-server.toml';
  const flyConfig = readFileSync(flyConfigPath, 'utf8');
  const configuredDockerfile = flyConfig.match(/^\s*dockerfile = "([^"]+)"$/m)?.[1];
  assert.ok(configuredDockerfile, 'fly.beeline-server.toml declares a build dockerfile');
  const configResolved = join(dirname(flyConfigPath), configuredDockerfile);
  assert.equal(configResolved, 'apps/server/Dockerfile');
  assert.ok(existsSync(configResolved));

  const root = mkdtempSync(join(tmpdir(), 'server-image-dockerfile-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'apps/server'), { recursive: true });
    mkdirSync(join(root, 'apps/infra'), { recursive: true });
    const expectedDockerfile = join(root, 'apps/server/Dockerfile');
    writeFileSync(expectedDockerfile, 'FROM scratch\n');
    writeFileSync(join(root, flyConfigPath), flyConfig);

    writeFileSync(join(root, 'bin/git'), `#!/bin/sh\nprintf "%s\\n" "$TEST_SHA"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'bin/docker'), `#!/bin/sh
case "$1 $2" in
  'pull registry.fly.io/beeline-server:source-'*) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
    // Enforce Fly's path resolution: a relative --dockerfile is resolved against
    // dirname(--config), while an absolute path is used directly.
    writeFileSync(join(root, 'bin/flyctl'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'deploy') process.exit(0);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const config = flag('--config');
const dockerfile = flag('--dockerfile');
if (!config || !dockerfile) {
  console.error('missing --config or --dockerfile');
  process.exit(2);
}
const resolved = path.isAbsolute(dockerfile) ? dockerfile : path.resolve(path.dirname(config), dockerfile);
if (!fs.existsSync(resolved)) {
  console.error('Dockerfile not found at ' + resolved);
  process.exit(1);
}
fs.appendFileSync(process.env.RESOLVED_LOG, resolved + '\\n');
`, { mode: 0o755 });

    const resolvedLog = join(root, 'resolved.log');
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, IMAGE_REF: image,
      TEST_SHA: sha, RESOLVED_LOG: resolvedLog };

    // Confirm the check fails when a relative apps/server/Dockerfile is resolved against apps/infra/.
    assert.throws(() => execFileSync(join(root, 'bin/flyctl'), [
      'deploy', '.', '--local-only', '--config', flyConfigPath, '--dockerfile', 'apps/server/Dockerfile',
    ], { cwd: root, env, stdio: 'pipe' }), /apps\/infra\/apps\/server\/Dockerfile/);

    execFileSync('bash', [script, 'prebuild', sha], { cwd: root, env, stdio: 'pipe' });
    execFileSync('bash', [script, 'release', sha, version], { cwd: root, env, stdio: 'pipe' });

    const resolvedPaths = readFileSync(resolvedLog, 'utf8').trim().split('\n');
    const canonicalExpected = realpathSync(expectedDockerfile);
    assert.deepEqual(resolvedPaths, [canonicalExpected, canonicalExpected]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
