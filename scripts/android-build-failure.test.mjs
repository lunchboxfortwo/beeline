import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('a failed release command retains its exit code and prints a visible failure summary', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'beeline-build-failure-'));
  try {
    const scripts = resolve(root, 'apps/mobile/scripts');
    const bin = resolve(root, 'bin');
    mkdirSync(scripts, { recursive: true }); mkdirSync(bin);
    copyFileSync('apps/mobile/scripts/android-build.sh', resolve(scripts, 'android-build.sh'));
    writeFileSync(resolve(scripts, 'android-teardown.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(resolve(bin, 'npx'), '#!/bin/sh\necho "prebuild fixture failed" >&2\nexit 23\n', { mode: 0o755 });
    const result = spawnSync('bash', [resolve(scripts, 'android-build.sh')], { encoding: 'utf8', env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root,
      ANDROID_SIDELOAD_KEYSTORE_B64: 'Zml4dHVyZQ==', ANDROID_SIDELOAD_KEY_ALIAS: 'fixture',
      ANDROID_SIDELOAD_STORE_PASSWORD: 'fixture', ANDROID_SIDELOAD_KEY_PASSWORD: 'fixture',
    } });
    assert.equal(result.status, 23);
    assert.match(result.stderr, /prebuild fixture failed/);
    assert.match(result.stderr, /Android release build failed \(exit 23\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
