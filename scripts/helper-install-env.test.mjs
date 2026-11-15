import assert from 'node:assert/strict';
import test from 'node:test';
import { helperInstallAgentEnv } from './helper-install-env.mjs';

test('native install acceptance keeps lab HOME/XDG paths when ACP replaces the child environment', () => {
  const env = helperInstallAgentEnv({ HOME: '/lab/home', XDG_CONFIG_HOME: '/lab/config', XDG_STATE_HOME: '/lab/state', PATH: '/lab/bin',
    GITHUB_TOKEN: 'production-github', OPENAI_API_KEY: 'production-model', BEELINE_NATIVE_MANAGER: '/production/manager' });
  assert.equal(env.HOME, '/lab/home');
  assert.equal(env.XDG_CONFIG_HOME, '/lab/config');
  assert.equal(env.XDG_STATE_HOME, '/lab/state');
  assert.equal(env.BEELINE_LAB, '1');
  assert.equal(env.PATH, '/lab/bin');
  assert.equal(env.OPENAI_COMPAT_API_KEY, 'install-probe');
  assert.equal(env.OPENAI_COMPAT_BASE_URL, 'http://127.0.0.1:1/v1');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BEELINE_NATIVE_MANAGER, undefined);
});
