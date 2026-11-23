import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { helperStatusLines, helperStatusPath, type HelperStatusFile } from './helper-status.js';
import { requestMachine } from './machine-control.js';
import { runMachineHelper } from './machine-helper.js';
import { findAgentRuntimeConfigPaths, identityFromKey, writeRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';
import { SystemdNotifier } from './systemd.js';

it('forgets a deleted agent: no local record keeps it hosted or listed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-retired-agent-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: root, BEELINE_LIB_DIR: '' };
  const ids: string[] = [];
  const configs: string[] = [];
  for (let index = 1; index <= 3; index++) {
    const secretKeyHex = index.toString(16).padStart(64, '0');
    const identity = identityFromKey(secretKeyHex, `Agent ${index}`);
    const stored = { name: identity.name, publicKey: identity.publicKey, secretKeyHex };
    ids.push(identity.publicKey);
    configs.push(await writeRuntimeRecord({ version: 2, supervisorRoot: root, communityId: 'workspace',
      agent: stored, body: stored, rooms: [], agentBinary: process.execPath } as AgentRuntimeRecord));
  }
  const [kept, retired, unpaired] = ids as [string, string, string];
  let markReady!: () => void;
  const ready = new Promise<void>(done => { markReady = done; });
  const notify = vi.spyOn(SystemdNotifier.prototype, 'ready').mockImplementation(async () => markReady());
  const signals = new EventEmitter();
  const tasks: Promise<unknown>[] = [];
  const helper = runMachineHelper({
    signals, env,
    runAgent: (path, host, signal) => {
      const task = (async () => {
        const runtime = JSON.parse(await readFile(path, 'utf8')) as AgentRuntimeRecord;
        host.established(runtime.agent.publicKey);
        if (runtime.agent.publicKey === retired) {
          // Server-confirmed removal: retirement reclaims the runtime and keeps
          // only Squire-owned ancestors, as `retireRemovedAgent` does.
          await rm(dirname(path), { recursive: true, force: true });
          await mkdir(join(dirname(path), 'rooms/room/agent-home/.trusty-squire'), { recursive: true });
          return 'agent-removed' as const;
        }
        await new Promise<void>(done => {
          signal.addEventListener('abort', () => done(), { once: true });
          if (signal.aborted) done();
        });
        return 'stopped' as const;
      })();
      tasks.push(task);
      return task;
    },
  });
  const listed = (status: HelperStatusFile) => Object.keys(status.agents).sort();
  try {
    await ready;
    let status = await requestMachine(root, { operation: 'status' }, current =>
      listed(current).join() === [kept, unpaired].sort().join() &&
      Object.values(current.agents).every(agent => agent.state === 'serving'));
    expect(listed(status)).toEqual([kept, unpaired].sort());

    // The owner removes another agent's runtime by hand, then reloads.
    await rm(dirname(configs[2]!), { recursive: true, force: true });
    signals.emit('SIGHUP');
    status = await requestMachine(root, { operation: 'status' }, current =>
      listed(current).join() === kept && current.agents[kept]?.state === 'serving');
    expect(listed(status)).toEqual([kept]);

    // Residue without a runtime record never comes back on a later rescan.
    signals.emit('SIGHUP');
    status = await requestMachine(root, { operation: 'status' }, current => current.processState === 'serving');
    expect(listed(status)).toEqual([kept]);
    expect(await findAgentRuntimeConfigPaths(env)).toEqual([configs[0]]);
    const lines = await helperStatusLines(env);
    expect(lines.slice(1)).toEqual([expect.stringMatching(new RegExp(`^agent ${kept.slice(0, 12)}  serving`))]);
    await vi.waitFor(async () => {
      const written = JSON.parse(await readFile(helperStatusPath(root), 'utf8')) as HelperStatusFile;
      expect(listed(written)).toEqual([kept]);
    });
  } finally {
    signals.emit('SIGTERM');
    await (await helper).settled;
    await Promise.all(tasks);
    notify.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
