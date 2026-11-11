import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { stopAgentProcess } from './agent-process.js';
import { runMachineHelper } from './machine-helper.js';
import { runAgentRuntime, type HostedAgent } from './agent-runtime.js';
import { AgentLifecycle } from './helper-lifecycle.js';
import { writeUpdateState } from './self-update.js';
import { identityFromKey, writeRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';

const observed = vi.hoisted(() => ({ serving: new Set<string>(), wake: () => {} }));

vi.mock('./agent-usage-refresh.js', () => ({
  createUsageRefresh: () => Object.assign(async () => {}, { attach: async () => {} }),
}));
vi.mock('./bwrap-sandbox.js', () => ({
  BUBBLEWRAP_INSTALL_BUDGET_MS: 1,
  ensureBwrapSandbox: async () => ({ advisory: 'isolated test' }),
}));
vi.mock('./model-catalog-sync.js', () => ({ syncAgentModelCatalog: async () => 'unchanged' }));
vi.mock('./connector-assignments.js', () => ({
  ConnectorAssignmentLoop: class { start() {} stop() {} wake() {} },
}));
vi.mock('./daemon-api-client.js', async (original) => {
  const actual = await original<typeof import('./daemon-api-client.js')>();
  return {
    ...actual,
    activateDaemonTransport: async (path: string) => {
      const { readRuntimeRecord } = await import('./runtime.js');
      const runtime = await readRuntimeRecord(path);
      const client = new Proxy({
        channel: { isOpen: () => true },
        execute: async () => ({ model: 'fixture-model' }),
      }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
      return { runtime, client };
    },
  };
});
vi.mock('./thin-core.js', () => ({
  ThinDaemonCore: class {
    constructor(private readonly runtime: AgentRuntimeRecord) {}
    activeTurnCount() { return 0; }
    setInteractiveIdleListener() {}
    async run(options: { signal: AbortSignal; onEstablished(): Promise<void> }) {
      await options.onEstablished();
      observed.serving.add(this.runtime.agent.publicKey);
      observed.wake();
      await new Promise<void>(done => {
        options.signal.addEventListener('abort', () => done(), { once: true });
        if (options.signal.aborted) done();
      });
      return 'aborted';
    }
  },
}));

it('serves all seventeen agents without starting a harness during an update successor startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-startup-'));
  const signals = new EventEmitter();
  const clients = new Set<AcpClient>();
  const probes: number[] = [];
  let probeStarted!: () => void;
  const probe = new Promise<'probe'>(done => { probeStarted = () => done('probe'); });
  let checkBlocked = () => {};
  const blocked = new Promise<void>(done => {
    checkBlocked = () => { if (probes.length === 13 && observed.serving.size === 4) done(); };
  });
  observed.serving.clear();
  const served = new Promise<'serving'>(done => {
    observed.wake = () => {
      if (observed.serving.size === 17) done('serving');
      checkBlocked();
    };
  });
  const originalStart = AcpClient.prototype.startProcess;
  const start = vi.spyOn(AcpClient.prototype, 'startProcess').mockImplementation(function () {
    clients.add(this);
    this.once('stderr', () => {
      probes.push(this.processPid()!);
      checkBlocked();
    });
    return originalStart.call(this);
  });
  // A living child that never answers initialize reproduces the unbounded
  // startup-model await without relying on a clock, provider, or memory load.
  const silentHarness = "process.stdin.on('data', () => process.stderr.write('initialize-blocked'))";
  const responsiveHarness = `
    const readline = require('node:readline');
    const configOptions = [{id:'model',name:'Model',category:'model',type:'select',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture'}]}];
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (!request.id) return;
      const result = request.method === 'initialize' ? {protocolVersion:1,agentCapabilities:{}}
        : request.method === 'session/new' ? {sessionId:'fixture',configOptions} : {configOptions};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    });`;
  void blocked.then(() => probeStarted());
  const configs: string[] = [];
  for (let index = 1; index <= 17; index++) {
    const secretKeyHex = index.toString(16).padStart(64, '0');
    const identity = identityFromKey(secretKeyHex, `Agent ${index}`);
    const stored = { name: identity.name, publicKey: identity.publicKey, secretKeyHex };
    configs.push(await writeRuntimeRecord({
      version: 2, supervisorRoot: root, communityId: 'workspace', agent: stored, body: stored,
      rooms: [], agentKind: 'reference', agentBinary: process.execPath, mcpBinary: process.execPath,
      agentArgs: ['-e', index <= 4 ? responsiveHarness : silentHarness], modelSelection: { model: 'fixture-model' },
      transport: { kind: 'monolith', baseUrl: 'http://127.0.0.1:1', daemonToken: 'fixture' },
    } as AgentRuntimeRecord));
  }
  const layout = { libDir: join(root, 'lib/beeline'), binDir: join(root, 'bin'),
    releasesRoot: join(root, 'lib/beeline-releases') };
  for (const release of ['old', 'new']) {
    const releaseRoot = join(layout.releasesRoot, release);
    await mkdir(join(releaseRoot, 'lib/beeline'), { recursive: true });
    await writeFile(join(releaseRoot, 'lib/beeline/bundle.json'), JSON.stringify({ version: 'v0.1.0', commit: release }));
    await writeFile(join(releaseRoot, '.stage-ok'), `${'a'.repeat(64)}\n`);
  }
  await symlink('beeline-releases/old', layout.libDir);
  let exited!: () => void;
  const exit = new Promise<void>(done => { exited = done; });
  const predecessorSignals = new EventEmitter();
  const predecessorTasks: Promise<unknown>[] = [];
  const predecessor = runMachineHelper({
    configPaths: [configs[0]!], signals: predecessorSignals, exitProcess: () => exited(),
    env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: root,
      BEELINE_LIB_DIR: layout.libDir, BEELINE_EXECUTING_RELEASE: 'old' },
    runUpdateWorker: async () => { await writeUpdateState(layout, { stagedReleaseId: 'new', lastCheckResult: 'verified' }); },
    runAgent: (_path, host, signal) => {
      const task = (async () => {
        const detach = host.attach({ agentId: 'predecessor', runtimeDir: root,
          lifecycle: new AgentLifecycle({ controller: new AbortController() }),
          core: { activeTurnCount: () => 0, quiesceForUpdate() {} } as HostedAgent['core'] });
        host.notifyReleaseAvailable('new');
        await new Promise<void>(done => {
          signal.addEventListener('abort', () => done(), { once: true });
          if (signal.aborted) done();
        });
        detach();
        return 'stopped' as const;
      })();
      predecessorTasks.push(task);
      return task;
    },
  });
  await exit;
  await (await predecessor).settled;
  await Promise.all(predecessorTasks);
  const successorTasks: Promise<unknown>[] = [];
  const helper = runMachineHelper({
    configPaths: configs, signals,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: root,
      BEELINE_LIB_DIR: layout.libDir, BEELINE_EXECUTING_RELEASE: 'new' },
    runUpdateWorker: async () => {},
    runAgent: (...args) => {
      const task = runAgentRuntime(...args);
      successorTasks.push(task);
      return task;
    },
  });
  try {
    expect(await Promise.race([served, probe])).toBe('serving');
    expect(start).not.toHaveBeenCalled();
    expect(probes).toEqual([]);
  } finally {
    if (clients.size) await blocked;
    signals.emit('SIGTERM');
    await Promise.all([...clients].map(client => stopAgentProcess(client)));
    await (await helper).settled;
    await Promise.all(successorTasks);
    start.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
