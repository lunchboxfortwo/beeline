import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('mounts the short TMPDIR as a real directory and reaches a bridge started afterward', () => {
  // Give the fixture its own /var/tmp so it can create the short link even
  // when Vitest itself is running in a read-only Beeline sandbox.
  const result = spawnSync('/usr/bin/bwrap', [
    '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--tmpfs', '/var/tmp', '--tmpfs', '/mnt',
    '--setenv', 'XDG_STATE_HOME', '/mnt/' + 'long-state-directory/'.repeat(6), '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { dirname } from 'node:path';
      import { createInterface } from 'node:readline';
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
      assert.equal(existsSync(dirname(bridgeSocket)), false);
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
          process.stdin.once('data', () => {
            const peer = require('node:net').createConnection(process.argv[1]);
            peer.setEncoding('utf8');
            let reply = '';
            peer.on('data', chunk => { reply += chunk; });
            peer.on('end', () => assert.equal(reply, 'bridge ready'));
          });
          console.log('sandbox ready');
        \`, bridgeSocket],
      });
      const sandbox = spawn(command.command, command.args, {
        env: { ...process.env, TMPDIR: tmpDir },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const ended = once(sandbox, 'close');
      const lines = createInterface({ input: sandbox.stdout });
      const bridge = createServer(peer => peer.end('bridge ready'));
      try {
        await Promise.race([
          once(lines, 'line').then(([line]) => assert.equal(line, 'sandbox ready')),
          ended.then(([code]) => assert.fail('sandbox exited before ready: ' + code)),
        ]);
        await preparePrivateSocketDirectory(bridgeSocket);
        bridge.listen(bridgeSocket);
        await once(bridge, 'listening');
        sandbox.stdin.end('connect');
        assert.equal((await ended)[0], 0);
      } finally {
        sandbox.kill();
        if (bridge.listening) await new Promise(done => bridge.close(done));
      }
      assert.equal(lstatSync(tmpDir).isSymbolicLink(), true);
      assert.equal(readFileSync(scratch + '/proof', 'utf8'), 'scratch');
    `,
  ], { encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
});
