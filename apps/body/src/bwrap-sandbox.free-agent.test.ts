import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('starts a free-agent Room with absent native logins, masked proxy credentials and writable private state', () => {
  const home = mkdtempSync(`${testTmpDir()}/beeline-free-agent-sandbox-`);
  roots.push(home);
  const room = join(home, '.local/state/beeline/agents/agent/rooms/room');
  const state = join(room, 'state');
  const privateHome = join(room, 'agent-home/user');
  const scratch = join(room, 'agent-home/tmp');
  const proxy = join(home, '.config/beeline/cliproxy/auth');
  const piState = harnessHomeStateDirs('/usr/local/bin/pi-acp', privateHome);
  for (const path of [state, scratch, proxy, ...piState]) mkdirSync(path, { recursive: true });
  const secret = join(proxy, 'login.json');
  writeFileSync(secret, 'host-refresh-token');
  writeFileSync(join(home, 'settings'), 'host-settings');
  const masks = credentialMaskPaths(undefined, home);
  expect(masks.some(mask => mask.create)).toBe(true);
  const command = wrapAgentCommand({
    bwrapPath: 'bwrap',
    spec: {
      mode: 'readonly', cwd: room, harnessHomeStateDirs: piState, tmpDir: scratch,
      additionalWritablePaths: [state, join(room, 'agent-home')], maskPaths: masks,
    },
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      assert.equal(process.getuid(), ${process.getuid!()});
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
      assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), ${JSON.stringify(readlinkSync('/proc/self/ns/pid'))});
      assert.equal(fs.existsSync(${JSON.stringify(secret)}), false);
      assert.equal(fs.readdirSync('/dev/shm').some(name => name.startsWith('beeline-masks')), false);
      assert.equal(fs.readFileSync(${JSON.stringify(join(home, 'settings'))}, 'utf8'), 'host-settings');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(home, 'escape'))}, 'bad'), { code: 'EROFS' });
      fs.writeFileSync(${JSON.stringify(join(state, 'request.json'))}, 'model-request');
      fs.writeFileSync(${JSON.stringify(join(piState[0]!, 'session-map.json'))}, 'pi-session');
      for (const mask of ${JSON.stringify(masks.filter(mask => mask.create))}) {
        assert.equal(fs.readdirSync(mask.path).length, 0);
      }
    `],
  });
  const result = spawnSync(command.command, command.args, { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(readFileSync(secret, 'utf8')).toBe('host-refresh-token');
  expect(readFileSync(join(state, 'request.json'), 'utf8')).toBe('model-request');
  for (const mask of masks.filter(mask => mask.create)) expect(existsSync(mask.path)).toBe(false);
});
