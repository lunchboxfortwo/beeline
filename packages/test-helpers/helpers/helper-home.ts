import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll } from 'vitest';
import { isolatedNativeProof } from '../../../apps/body/src/lifecycle-test-guard.js';
import { testTmpDir } from './helper.js';

// Every test child inherits private paths and an unreachable user bus.
// Native acceptance uses the separately supervised proof container.
if (!isolatedNativeProof(process.env)) {
  const home = mkdtempSync(resolve(testTmpDir(), 'beeline-test-'));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  process.once('exit', cleanup);
  // Vitest runs suite hooks in reverse registration order, so the tests'
  // own teardown can stop their children before we remove their home.
  afterAll(() => {
    process.off('exit', cleanup);
    cleanup();
  });

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = resolve(home, '.config');
  process.env.XDG_STATE_HOME = resolve(home, '.local/state');
  process.env.XDG_RUNTIME_DIR = resolve(home, 'run');
  for (const path of [
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_STATE_HOME,
    process.env.XDG_RUNTIME_DIR,
  ])
    mkdirSync(path, { recursive: true });
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${home}/run/no-user-bus`;
  process.env.BEELINE_LIB_DIR = '';
  process.env.BEELINE_INSTALL_DIR = '';
  process.env.BEELINE_INSTALL_LIB_DIR = '';
}
