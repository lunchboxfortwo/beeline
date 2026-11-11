import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runMachineHelper } from './machine-helper.js';
import { identityFromKey, writeRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';
import { SystemdNotifier } from './systemd.js';
import { requestMachine } from './machine-control.js';

const disk = vi.hoisted(() => ({ path: '', entered: () => {}, wait: Promise.resolve(),
  statusPrefix: '', statusEntered: () => {}, statusWait: Promise.resolve() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]) === disk.path) { disk.entered(); await disk.wait; }
    return actual.readFile(...args);
  }, writeFile: async (...args: Parameters<typeof writeFile>) => {
    if (disk.statusPrefix && String(args[0]).startsWith(disk.statusPrefix)) {
      disk.statusEntered();
      await disk.statusWait;
    }
    return actual.writeFile(...args);
  } };
});

it('keeps native readiness and a sibling independent of one stalled configuration read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-slow-start-'));
  const configs: string[] = [];
  for (let index = 1; index <= 2; index++) {
    const secretKeyHex = index.toString(16).padStart(64, '0');
    const identity = identityFromKey(secretKeyHex, `Agent ${index}`);
    const stored = { name: identity.name, publicKey: identity.publicKey, secretKeyHex };
    configs.push(await writeRuntimeRecord({ version: 2, supervisorRoot: root, communityId: 'workspace',
      agent: stored, body: stored, rooms: [], agentBinary: process.execPath } as AgentRuntimeRecord));
  }
  let release!: () => void;
  disk.path = configs[0]!;
  disk.wait = new Promise<void>(done => { release = done; });
  const blocked = new Promise<'blocked'>(done => { disk.entered = () => done('blocked'); });
  let releaseStatus!: () => void;
  disk.statusPrefix = join(root, 'beeline/helper/status.json');
  disk.statusWait = new Promise<void>(done => { releaseStatus = done; });
  const statusBlocked = new Promise<void>(done => { disk.statusEntered = done; });
  let markReady!: () => void;
  const ready = new Promise<'ready'>(done => { markReady = () => done('ready'); });
  const notify = vi.spyOn(SystemdNotifier.prototype, 'ready').mockImplementation(async () => markReady());
  let siblingStarted!: () => void;
  const sibling = new Promise<void>(done => { siblingStarted = done; });
  const signals = new EventEmitter();
  const tasks: Promise<unknown>[] = [];
  const helper = runMachineHelper({
    configPaths: configs, signals,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: root, BEELINE_LIB_DIR: '' },
    runAgent: (path, host, signal) => {
      const task = (async () => {
        const runtime = JSON.parse(await readFile(path, 'utf8')) as AgentRuntimeRecord;
        host.established(runtime.agent.publicKey);
        if (path === configs[1]) siblingStarted();
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
  try {
    expect(await Promise.race([ready, blocked])).toBe('ready');
    await blocked;
    await sibling;
    await statusBlocked;
    const status = await requestMachine(root, { operation: 'status' }, current => current.processState === 'serving');
    expect(Object.values(status.agents).map(agent => agent.state).sort()).toEqual(['serving', 'starting']);
  } finally {
    release();
    releaseStatus();
    signals.emit('SIGTERM');
    await (await helper).settled;
    await Promise.all(tasks);
    disk.path = '';
    disk.statusPrefix = '';
    notify.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
