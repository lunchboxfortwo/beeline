import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { updateSquireBrokerInstall } from './squire-host.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Before, the runner settled on `close`: a background child holding npm's pipes
// kept `npm view` and `npm install` pending for its whole life.
it.skipIf(process.platform === 'win32')(
  'settles each npm step on its exit, not on a pipe holder',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'squire-install-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'npm'),
      '#!/bin/sh\nsleep 30 &\nif [ "$1" = view ]; then echo 9.9.9; else echo "install refused" >&2; exit 1; fi\n',
    );
    await chmod(join(bin, 'npm'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const started = Date.now();
    await expect(updateSquireBrokerInstall(join(root, 'home'))).rejects.toThrow(
      'Trusty Squire broker install failed: install refused',
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);
