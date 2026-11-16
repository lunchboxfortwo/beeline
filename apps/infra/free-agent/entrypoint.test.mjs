import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
for (const exitCode of [0, 1, 78])
  test(`persistent HOME's old release cannot override the baked helper (exit ${exitCode})`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-baked-helper-'));
    try {
      const home = resolve(root, 'persistent-home');
      const oldRelease = resolve(home, '.local/lib/beeline-releases/old-release');
      const anchor = resolve(home, '.local/lib/beeline');
      const bakedHelper = resolve(root, 'image/opt/beeline/helper');
      await mkdir(resolve(home, '.local/bin'), { recursive: true });
      await mkdir(resolve(oldRelease, 'bin'), { recursive: true });
      await symlink('beeline-releases/old-release', anchor);
      await writeFile(resolve(oldRelease, 'bin/beeline'), '#!/bin/sh\necho stale-helper\n', { mode: 0o755 });
      await writeFile(resolve(home, '.local/bin/beeline'),
        '#!/bin/sh\nexec "$HOME/.local/lib/beeline/bin/beeline" "$@"\n', { mode: 0o755 });
      await mkdir(resolve(bakedHelper, 'bin'), { recursive: true });
      await writeFile(resolve(bakedHelper, 'bin/beeline'),
        `#!/bin/sh\necho "baked-helper:$*"\nexit ${exitCode}\n`, { mode: 0o755 });
      const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'entrypoint.sh');
      await writeFile(script, source.replaceAll('/opt/beeline/helper', bakedHelper));
      const child = spawn('/bin/sh', [script], { env: { ...process.env,
        HOME: home } });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const [code] = await once(child, 'exit');
      assert.equal(output, 'baked-helper:free-agent\n', errors);
      assert.equal(code, exitCode);
      assert.equal(await readlink(anchor), 'beeline-releases/old-release');
      assert.doesNotMatch(source, /install\.sh|setTimeout|timeout |while|sleep /);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
