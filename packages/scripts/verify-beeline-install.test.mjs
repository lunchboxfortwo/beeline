import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './verify-beeline-install.mjs';
import { recoveryCliBundleArgs } from './recovery-cli-bundle.mjs';

test('helper recovery bundle loads session commands after being copied outside the install', () => {
  const directory = mkdtempSync(join(tmpdir(), 'beeline-recovery-bundle-'));
  try {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const output = join(directory, 'usebeeline.mjs');
    // Use the helper's build recipe and real compiled entry, without npm's
    // import.meta.url define. No helper lifecycle or network calls are needed.
    execFileSync('npx', recoveryCliBundleArgs(join(root, 'apps/body/dist/recovery-cli.js'), output), {
      cwd: root, stdio: 'pipe', timeout: 30_000,
    });
    const result = spawnSync(process.execPath, [output, 'session', 'status'], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: directory,
        XDG_CONFIG_HOME: join(directory, 'config'), XDG_STATE_HOME: join(directory, 'state') },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run keeps stdin open until the requested JSON-RPC reply is complete', async () => {
  const server = String.raw`
    let scheduled = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\n');
      }, 25);
    });
    process.stdin.on('end', () => process.exit(0));
  `;

  const result = await run(process.execPath, ['--input-type=module', '--eval', server], {
    input: '{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n',
    untilAnswered: 2,
    timeoutMs: 1_000,
  });

  const ids = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).id);
  assert.deepEqual(ids, [1, 2]);
});

test('run preserves child stderr when waiting for a reply times out', async () => {
  const server = String.raw`
    process.stderr.write('probe diagnostic from stderr\n');
    process.stdin.resume();
  `;

  await assert.rejects(
    run(process.execPath, ['--input-type=module', '--eval', server], {
      input: '{"jsonrpc":"2.0","id":2}\n',
      untilAnswered: 2,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /timed out after 1000ms/);
      assert.match(error.message, /probe diagnostic from stderr/);
      return true;
    },
  );
});
