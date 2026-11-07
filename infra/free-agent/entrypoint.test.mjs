import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import './reconcile-broker-marker.test.mjs';

for (const managerRunning of [true, false])
  test(`hosted recovery restores the broker with machine HOME (manager running: ${managerRunning})`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-hosted-recovery-'));
    try {
      const state = resolve(root, 'manager-ready');
      const log = resolve(root, 'calls');
      const bin = resolve(root, 'bin');
      await mkdir(bin);
      if (managerRunning) await writeFile(state, '');
      await writeFile(resolve(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(resolve(bin, 'systemctl'), `#!/bin/sh
echo "$HOME|$XDG_CONFIG_HOME|$XDG_RUNTIME_DIR|$*" >> '${log}'
if [ "$2" = show-environment ]; then test -f '${state}'; fi
`, { mode: 0o755 });
      const manager = resolve(bin, 'manager');
      await writeFile(manager, `#!/usr/bin/python3
import os,socket
with open('${log}','a') as log: log.write('manager:'+os.environ['HOME']+':'+os.environ['XDG_CONFIG_HOME']+':'+os.environ['DBUS_SESSION_BUS_ADDRESS']+'\\n')
open('${state}','w').close()
with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as notify:
  notify.connect(os.environ['NOTIFY_SOCKET']);notify.send(b'READY=1')
import sys
sys.stdin.read()
`, { mode: 0o755 });
      const source = await readFile(new URL('./hosted-services.sh', import.meta.url), 'utf8');
      const script = resolve(root, 'services.sh');
      await writeFile(script, source.replaceAll('/lib/systemd/systemd', manager)
        .replaceAll('/run/user/0', resolve(root, 'run'))
        .replaceAll('/run/systemd/system', resolve(root, 'system'))
        .replaceAll('/opt/beeline/start-hosted-manager.py',new URL('./start-hosted-manager.py',import.meta.url).pathname));
      const child = spawn('/bin/sh', [script], { env: { ...process.env,
        PATH: `${bin}:${process.env.PATH}`, HOME: resolve(root, 'agent-home'),
        XDG_CONFIG_HOME: resolve(root, 'agent-config'), XDG_RUNTIME_DIR: '/wrong-runtime' } });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      const calls = await readFile(log, 'utf8');
      assert.match(calls, /\/root\|\/root\/\.config\|.*\|--user start trusty-squire-broker.service/);
      assert.equal(calls.includes('agent-home'), false);
      assert.equal(calls.includes('agent-config'), false);
      assert.equal(calls.includes('manager:/root:/root/.config:'), !managerRunning);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test('a failed hosted service manager stops boot before the helper or installer runs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-hosted-services-'));
  try {
    await mkdir(resolve(root, '.local/bin'), { recursive: true });
    await writeFile(resolve(root, '.local/bin/beeline'), '#!/bin/sh\necho unexpected-helper\n', { mode: 0o755 });
    const service = resolve(root, 'services.sh');
    const installer = resolve(root, 'install.sh');
    await writeFile(service, '#!/bin/sh\necho manager-unavailable >&2\nexit 78\n');
    await writeFile(installer, '#!/bin/sh\necho unexpected-installer\n');
    const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
    const script = resolve(root, 'entrypoint.sh');
    await writeFile(script, source.replaceAll('/opt/beeline/hosted-services.sh', service)
      .replaceAll('/opt/beeline/install.sh', installer));
    const child = spawn('/bin/sh', [script], { env: { ...process.env, HOME: root, BEELINE_HOSTED_SERVICES: '1' } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 78);
    assert.equal(output, '');
    assert.match(errors, /manager-unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
        HOME: home, BEELINE_HOSTED_SERVICES: '0' } });
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
