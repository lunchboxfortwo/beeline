import { once, EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import type { HostedAgent } from './agent-runtime.js';
import { AgentLifecycle } from './helper-lifecycle.js';
import { runMachineHelper } from './machine-helper.js';
import { RegistryMcpHostBroker } from './registry-mcp.js';
import { identityFromKey } from './runtime.js';
import { writeUpdateState } from './self-update.js';

it('exits for a verified idle update without waiting for retained local clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-handoff-'));
  const layout = {
    libDir: join(root, 'lib/beeline'),
    binDir: join(root, 'bin'),
    releasesRoot: join(root, 'lib/beeline-releases'),
  };
  const identity = identityFromKey('01'.repeat(32), 'Idle agent');
  const stored = {
    name: identity.name,
    publicKey: identity.publicKey,
    secretKeyHex: '01'.repeat(32),
  };
  const config = join(root, 'agent/runtime.json');
  const signals = new EventEmitter();
  const exit = vi.fn();
  const sockets = new Set<WebSocket>();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('message', (bytes) => {
      const frame = JSON.parse(String(bytes));
      if (frame.type === 'register-machine')
        socket.send(
          JSON.stringify({
            type: 'registered-machine',
            agents: frame.agents.map((agent: { agentId: string }) => ({
              type: 'registered',
              agentId: agent.agentId,
            })),
          }),
        );
    });
  });
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      communityId: 'workspace',
      agent: stored,
      body: stored,
      rooms: [],
    }),
  );
  for (const release of ['old', 'new']) {
    await mkdir(join(layout.releasesRoot, release, 'lib/beeline'), { recursive: true });
    await writeFile(
      join(layout.releasesRoot, release, 'lib/beeline/bundle.json'),
      JSON.stringify({ version: 'v0.1.0', commit: release }),
    );
    await writeFile(join(layout.releasesRoot, release, '.stage-ok'), `${'a'.repeat(64)}\n`);
  }
  await symlink('beeline-releases/old', layout.libDir);
  const broker = new RegistryMcpHostBroker(root, fetch, undefined, join(root, 'broker.sock'));
  await broker.start();
  const retained = createConnection(broker.socketPath);
  await once(retained, 'connect');
  let releaseAvailable: (() => void) | undefined;
  let connected = false;
  let cleanupFinished = false;
  let stageNew = false;
  const helper = runMachineHelper({
    configPaths: [config],
    signals,
    exitProcess: exit,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      BEELINE_LIB_DIR: layout.libDir,
    },
    runUpdateWorker: async () => {
      await writeUpdateState(layout, {
        lastCheckResult: 'verified',
        stagedReleaseId: stageNew ? 'new' : 'old',
      });
    },
    runAgent: async (_path, host, signal) => {
      const controller = new AbortController();
      const lifecycle = new AgentLifecycle({ controller });
      const core = {
        activeTurnCount: () => 0,
        quiesceForUpdate: vi.fn(),
      } as unknown as HostedAgent['core'];
      const detach = host.attach({
        agentId: identity.publicKey,
        runtimeDir: root,
        lifecycle,
        core,
      });
      const channel = host
        .machineLink(`http://127.0.0.1:${address.port}`)
        .attach(identity.publicKey, {
          registration: () => ({ token: 'local-test' }),
          onMessage: () => {},
          onUpdateRequired: () => {},
          onOpen: () => {
            connected = true;
            host.established(identity.publicKey);
          },
          onClose: () => {
            connected = false;
          },
        });
      releaseAvailable = () => host.notifyReleaseAvailable('new');
      channel.start();
      await new Promise<void>((done) => {
        signal.addEventListener('abort', () => done(), { once: true });
        if (signal.aborted) done();
      });
      // The real broker's server.close waits for this client. It cannot own
      // whether an already-disconnected machine gets its native restart.
      await broker.stop();
      cleanupFinished = true;
      channel.stop();
      detach();
      return 'stopped';
    },
  });
  try {
    await vi.waitFor(() => expect(connected).toBe(true));
    stageNew = true;
    releaseAvailable!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(connected).toBe(false);
    expect(cleanupFinished).toBe(false);
    expect(retained.destroyed).toBe(false);
  } finally {
    retained.resume();
    retained.end('{}');
    await once(retained, 'close');
    signals.emit('SIGTERM');
    await helper;
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
