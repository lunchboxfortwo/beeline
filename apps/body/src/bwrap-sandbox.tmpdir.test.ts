import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('mounts the short TMPDIR as a real directory and keeps the session bridge reachable', () => {
  // Give the fixture its own /var/tmp so it can create the short link even
  // when Vitest itself is running in a read-only Beeline sandbox.
  const result = spawnSync('/usr/bin/bwrap', [
    '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--tmpfs', '/var/tmp', '--tmpfs', '/mnt',
    '--setenv', 'XDG_STATE_HOME', '/mnt/' + 'long-state-directory/'.repeat(6), '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { execFile } from 'node:child_process';
      import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { promisify } from 'node:util';
      import { wrapAgentCommand } from ${JSON.stringify(new URL('./bwrap-sandbox.ts', import.meta.url).href)};
      import { preparePrivateSocketDirectory } from ${JSON.stringify(new URL('./local-socket.ts', import.meta.url).href)};
      import { bridgeSocketPath } from ${JSON.stringify(new URL('./session-join/bridge-socket.ts', import.meta.url).href)};
      import { stateDir } from ${JSON.stringify(new URL('./session-join/store.ts', import.meta.url).href)};

      const scratch = '/mnt/agent-home/tmp';
      const tmpDir = '/var/tmp/beeline-0123456789ab';
      mkdirSync(scratch, { recursive: true });
      symlinkSync('../../mnt/agent-home/tmp', tmpDir);
      const bridgeSocket = bridgeSocketPath(stateDir());
      assert(bridgeSocket.startsWith('/var/tmp/'));
      await preparePrivateSocketDirectory(bridgeSocket);
      const bridge = createServer(peer => peer.end('bridge ready'));
      await new Promise((done, reject) => {
        bridge.once('error', reject);
        bridge.listen(bridgeSocket, done);
      });
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
          const peer = require('node:net').createConnection(process.argv[1]);
          peer.setEncoding('utf8');
          let reply = '';
          peer.on('data', chunk => { reply += chunk; });
          peer.on('end', () => assert.equal(reply, 'bridge ready'));
        \`, bridgeSocket],
      });
      try {
        await promisify(execFile)(command.command, command.args, {
          env: { ...process.env, TMPDIR: tmpDir },
          timeout: 5000,
        });
      } finally {
        await new Promise(done => bridge.close(done));
      }
      assert.equal(lstatSync(tmpDir).isSymbolicLink(), true);
      assert.equal(readFileSync(scratch + '/proof', 'utf8'), 'scratch');
    `,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});
