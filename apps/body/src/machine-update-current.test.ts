import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runMachineHelper } from './machine-helper.js';
import { askMachine } from './machine-control.js';
import { SystemdNotifier } from './systemd.js';

it('answers both overlapping updates for the already-loaded release through the real helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-current-requests-'));
  const libDir = join(root, 'lib/beeline');
  const releasesRoot = join(root, 'lib/beeline-releases');
  await mkdir(join(releasesRoot, 'current/lib/beeline'), { recursive: true });
  await writeFile(join(releasesRoot, 'current/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.0.0', commit: 'current' }));
  await symlink('beeline-releases/current', libDir);
  let ready!: () => void;
  const serving = new Promise<void>(done => { ready = done; });
  const notifier = vi.spyOn(SystemdNotifier.prototype, 'ready').mockImplementation(async () => ready());
  const signals = new EventEmitter();
  const stateRoot = join(root, 'state');
  const helper = runMachineHelper({ configPaths: [], signals,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: stateRoot,
      BEELINE_LIB_DIR: libDir, BEELINE_EXECUTING_RELEASE: 'current' },
    runAgent: async () => 'stopped', exitProcess: () => {},
  });
  try {
    await serving;
    const before = await askMachine(stateRoot, { operation: 'status' });
    const answers = await Promise.all([
      askMachine(stateRoot, { operation: 'update', releaseId: 'current', sourceGeneration: before.generation }),
      askMachine(stateRoot, { operation: 'update', releaseId: 'current', sourceGeneration: before.generation }),
    ]);
    expect(answers.map(answer => answer.outcome)).toEqual(['current', 'current']);
    expect(answers.map(answer => answer.generation)).toEqual([before.generation, before.generation]);
  } finally {
    signals.emit('SIGTERM');
    await (await helper).settled;
    notifier.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
