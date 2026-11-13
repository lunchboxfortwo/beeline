import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCurrentRelease } from './connect-command.js';
import { convergeMachine, prepareMachineRelease } from './recovery.js';
import { MachineControl, machineControlPath, type MachineRequest } from './machine-control.js';
import { ReleaseTransaction } from './managed-update.js';
import { defaultBeelineInstallLayout, hostPlatformKey } from './self-update.js';
import type { HelperStatusFile } from './helper-status.js';
import { convergeNativeHelper } from './native-helper.js';

vi.mock('./native-helper.js', async original => ({
  ...await original<typeof import('./native-helper.js')>(),
  convergeNativeHelper: vi.fn(async () => process.pid),
}));
vi.mock('./recovery.js', async original => ({
  ...await original<typeof import('./recovery.js')>(),
  prepareMachineRelease: vi.fn(async () => ({ releaseId: 'npm-latest', identity: { version: 'v0.1.201' } })),
  convergeMachine: (options: Parameters<typeof import('./recovery.js').convergeMachine>[0]) =>
    original<typeof import('./recovery.js')>().then(module => module.convergeMachine({ ...options, run: async () => ({ stdout: '' }) })),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'beeline-connect-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
  vi.stubEnv('BEELINE_RECOVERY_SELECTED_RELEASE', '');
  const layout = defaultBeelineInstallLayout();
  const release = join(layout.releasesRoot, 'running-next');
  await mkdir(join(release, 'lib/beeline'), { recursive: true });
  await writeFile(join(release, 'lib/beeline/beeline-cli.mjs'), '');
  await writeFile(join(release, 'lib/beeline/bundle.json'), JSON.stringify({ version: 'v0.1.202-rc.5' }));
  await symlink('beeline-releases/running-next', layout.libDir);
  const agentId = 'a'.repeat(64);
  const siblingId = 'b'.repeat(64);
  const status: HelperStatusFile = {
    pid: process.pid, generation: 'running-generation', processState: 'serving',
    loadedRelease: 'running-next', loadedIdentity: { version: 'v0.1.202-rc.5' },
    updatedAt: new Date().toISOString(), agents: {
      [agentId]: { state: 'serving', enabled: true, status: 'serving', since: '' },
      [siblingId]: { state: 'needs-auth', enabled: true, status: 'sign in required', since: '' },
    },
  };
  const requests: MachineRequest[] = [];
  const handoff = vi.fn(async () => {});
  const update = new ReleaseTransaction({
    layout, loadedRelease: status.loadedRelease, env: process.env, idle: () => false,
    handoff, changed: () => {}, failed: () => {},
  });
  const control = new MachineControl(machineControlPath(process.env.XDG_STATE_HOME!), async request => {
    requests.push(request);
    if (request.operation === 'update') {
      await update.prepared(request.releaseId!);
      // Fail immediately instead of spending minutes waiting for the busy helper.
      throw new Error('connect requested a helper release swap while agents were busy');
    }
  });
  await control.start();
  control.publish(status);
  return { layout, agentId, status, requests, handoff, control, async close() {
    update.dispose(); await update.pending; await control.stop(); await rm(home, { recursive: true, force: true });
  } };
}

it.each(['v0.1.201', 'v0.1.202-rc.5', 'v0.1.203'])('reuses a busy helper when connect resolves %s under another release id', async version => {
  const helper = await fixture();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ bundles: {
    [hostPlatformKey()]: { file: 'older.tar.gz', sha256: 'a'.repeat(64), version },
  } })));
  try {
    await expect(installCurrentRelease(fetchImpl)).resolves.toEqual({
      binary: join(helper.layout.binDir, 'beeline'), version: 'v0.1.202-rc.5',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prepareMachineRelease).not.toHaveBeenCalled();
    expect(helper.requests.some(request => request.operation === 'update')).toBe(false);
    expect(helper.handoff).not.toHaveBeenCalled();
  } finally { await helper.close(); }
});

it('connect convergence waits only for the paired agent on the current helper generation', async () => {
  const helper = await fixture();
  try {
    const sibling = 'b'.repeat(64);
    const runtime = join(process.env.XDG_STATE_HOME!, 'beeline/agents', sibling);
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'runtime.json'), '{}');
    helper.status.desiredRelease = 'unrelated-background-update';
    helper.status.agents[helper.agentId]!.state = 'starting';
    helper.control.publish(helper.status);
    let finished = false;
    const converging = convergeMachine({ layout: helper.layout, agentIds: [helper.agentId], run: async () => ({ stdout: '' }) })
      .then(status => { finished = true; return status; });
    await vi.waitFor(() => expect(helper.requests.map(request => request.operation)).toEqual(['status', 'converge']));
    expect(finished).toBe(false);
    helper.status.agents[helper.agentId]!.state = 'serving';
    helper.control.publish(helper.status);
    await expect(converging)
      .resolves.toMatchObject({ generation: 'running-generation', loadedRelease: 'running-next' });
    expect(helper.requests.map(request => request.operation)).toEqual(['status', 'converge']);
    expect(helper.handoff).not.toHaveBeenCalled();
    expect(convergeNativeHelper).not.toHaveBeenCalled();
  } finally { await helper.close(); }
});

it('starts an absent helper after pairing without staging a release', async () => {
  const helper = await fixture();
  await helper.control.stop();
  vi.mocked(convergeNativeHelper).mockImplementationOnce(async () => {
    await helper.control.start();
    helper.control.publish(helper.status);
    return process.pid;
  });
  try {
    await expect(convergeMachine({ layout: helper.layout, agentIds: [helper.agentId] }))
      .resolves.toMatchObject({ loadedRelease: 'running-next' });
    expect(helper.requests.map(request => request.operation)).toEqual(['converge']);
    expect(convergeNativeHelper).toHaveBeenCalledWith(expect.objectContaining({ restart: true }));
    expect(prepareMachineRelease).not.toHaveBeenCalled();
  } finally { await helper.close(); }
});

it('still checks every enabled agent for an unscoped start or update', async () => {
  const helper = await fixture();
  try {
    await expect(convergeMachine({ layout: helper.layout })).rejects.toThrow('sign in required');
    expect(convergeNativeHelper).toHaveBeenCalled();
  } finally { await helper.close(); }
});
