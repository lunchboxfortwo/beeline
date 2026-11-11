import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { bootstrapMachine } from './recovery.js';
import { activeReleaseId, readUpdateState, writeUpdateState } from './self-update.js';

vi.mock('./native-helper.js', async original => ({
  ...await original<typeof import('./native-helper.js')>(),
  nativeSupervisor: () => 'systemd',
  nativeHelperStatus: async () => ({ MainPID: String(process.pid) }),
}));

it('consumes a staged boot once even when activation fails before the anchor changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-boot-selection-'));
  const layout = { libDir: join(root, 'lib/beeline'), releasesRoot: join(root, 'lib/beeline-releases'), binDir: join(root, 'bin') };
  for (const id of ['old', 'broken']) {
    await mkdir(join(layout.releasesRoot, id, 'lib/beeline'), { recursive: true });
    await writeFile(join(layout.releasesRoot, id, 'lib/beeline/beeline-cli.mjs'), '');
    await writeFile(join(layout.releasesRoot, id, '.stage-ok'), 'a'.repeat(64));
  }
  await symlink('beeline-releases/old', layout.libDir);
  // Force an activation failure before symlink replacement, as with an install
  // that cannot write its forwarders. The native restart must serve old next.
  await writeFile(layout.binDir, 'cannot create bin directory');
  await writeUpdateState(layout, { stagedReleaseId: 'broken', previousReleaseId: 'previous' });
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    BEELINE_LIB_DIR: layout.libDir, BEELINE_BOOT_LAUNCHER_PID: String(process.pid) };
  try {
    await expect(bootstrapMachine(env)).rejects.toThrow();
    expect(await activeReleaseId(layout)).toBe('old');
    expect((await readUpdateState(layout)).stagedReleaseId).toBeUndefined();
    await expect(bootstrapMachine(env)).resolves.toBe(join(layout.releasesRoot, 'old/lib/beeline/beeline-cli.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
