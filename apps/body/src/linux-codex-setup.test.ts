import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runAdapterInstall } from './agent-command.js';

// Explicit network proof: install the same pinned adapter used by codex-linux-1.
it.skipIf(process.platform !== 'linux' || !process.env.BEELINE_TEST_CODEX_SETUP)(
  'resolves and starts the installed Linux Codex adapter platform program',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-codex-setup-'));
    try {
      const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root };
      await runAdapterInstall({
        command: process.env.BEELINE_TEST_NPM ?? 'npm',
        args: ['install', '--prefix', root, '--no-save', '--no-audit', '--no-fund', '@agentclientprotocol/codex-acp@2.5.0'],
      }, { env, stdio: 'ignore' });
      expect(execFileSync(join(root, 'node_modules/.bin/codex'), ['--version'], { env, encoding: 'utf8' })).toMatch(/^codex-cli /);
      expect(execFileSync(join(root, 'node_modules/.bin/codex-acp'), ['--version'], { env, encoding: 'utf8' })).toContain('2.5.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
