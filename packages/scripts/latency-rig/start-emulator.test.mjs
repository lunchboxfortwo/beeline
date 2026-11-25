import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const launcher = new URL('./start-emulator.sh', import.meta.url).pathname;

for (const status of [0, 12]) {
  test(`the launcher releases its AVD after emulator exit ${status}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latency-emulator-test-'));
    const sdk = join(root, 'sdk');
    const bin = join(root, 'bin');
    const scratch = join(root, 'scratch');
    const evidence = join(root, 'evidence');
    const manager = join(sdk, 'cmdline-tools/latest/bin');
    const emulator = join(sdk, 'emulator');
    try {
      for (const dir of [bin, scratch, manager, emulator]) await mkdir(dir, { recursive: true });
      const fake = (dir, name, body) =>
        writeFile(join(dir, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
      await fake(bin, 'adb', "printf 'List of devices attached\\n'");
      await fake(bin, 'systemd-run', 'shift 6; exec "$@"');
      await fake(manager, 'avdmanager', 'mkdir "$ANDROID_AVD_HOME/test.avd"');
      await fake(emulator, 'emulator', `
        test -d "$ANDROID_AVD_HOME/test.avd"
        printf '%s\n' "$ANDROID_AVD_HOME" > "$EMULATOR_TEST_EVIDENCE"
        exit ${status}
      `);
      const run = exec('bash', [launcher], {
        env: {
          ...process.env,
          ANDROID_HOME: sdk,
          PATH: `${bin}:${process.env.PATH}`,
          LATENCY_RIG_SCRATCH_ROOT: scratch,
          LATENCY_RIG_CPU_QUOTA_PERCENT: '200',
          EMULATOR_TEST_EVIDENCE: evidence,
        },
      });
      if (status) await assert.rejects(run, { code: status });
      else await run;
      assert.ok((await readFile(evidence, 'utf8')).startsWith(`${scratch}/beeline-emulator.`));
      assert.deepEqual(await readdir(scratch), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
