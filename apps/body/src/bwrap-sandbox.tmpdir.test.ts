import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('mounts the short session TMPDIR as a real directory backed by private scratch', () => {
  // Give the fixture its own /var/tmp so it can create the short link even
  // when Vitest itself is running in a read-only Beeline sandbox.
  const result = spawnSync('/usr/bin/bwrap', [
    '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--tmpfs', '/var/tmp', '--tmpfs', '/mnt', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
      import { wrapAgentCommand } from ${JSON.stringify(new URL('./bwrap-sandbox.ts', import.meta.url).href)};

      const scratch = '/mnt/agent-home/tmp';
      const tmpDir = '/var/tmp/beeline-0123456789ab';
      mkdirSync(scratch, { recursive: true });
      symlinkSync('../../mnt/agent-home/tmp', tmpDir);
      const command = wrapAgentCommand({
        bwrapPath: '/usr/bin/bwrap',
        spec: { mode: 'readonly', cwd: process.cwd(), tmpDir },
        command: process.execPath,
        args: ['-e', \`
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const tmp = process.env.TMPDIR;
          assert.equal(tmp, '/var/tmp/beeline-0123456789ab');
          assert.equal(fs.lstatSync(tmp).isDirectory(), true, 'TMPDIR must be a directory');
          assert.equal(fs.realpathSync(tmp), tmp);
          fs.writeFileSync(tmp + '/proof', 'scratch');
        \`],
      });
      execFileSync(command.command, command.args, { env: { ...process.env, TMPDIR: tmpDir }, stdio: 'inherit' });
      assert.equal(lstatSync(tmpDir).isSymbolicLink(), true);
      assert.equal(readFileSync(scratch + '/proof', 'utf8'), 'scratch');
    `,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});
