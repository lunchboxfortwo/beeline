import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { runSquireBrokerLink } from './squire-broker-link.js';
import { HelperSquireTransport, StdioSquireMcpClient } from './squire-mcp-client.js';
import { SquireTaskRelay } from './squire-task-relay.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The broker's real identity-line + JSON-RPC Unix socket protocol. Browser
 * state belongs to each broker generation, exactly as on a process restart. */
async function brokerFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'squire-restart-'));
  const path = join(dir, 'mcp.sock');
  const peers = new Set<Socket>();
  const methods: string[] = [];
  let generation = 0;
  let nextSession = 0;
  let holdClicks = false;
  let server = createServer();
  const stop = async () => {
    for (const peer of peers) peer.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const start = async () => {
    generation++;
    const sessions = new Set<string>();
    server = createServer((peer) => {
      peers.add(peer);
      peer.on('close', () => peers.delete(peer));
      let buffer = '';
      let identity = false;
      peer.on('data', (chunk) => {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!identity) {
            expect(line).toBe('beeline-helper');
            identity = true;
            continue;
          }
          const frame = JSON.parse(line);
          if (frame.id === undefined) continue;
          methods.push(frame.method === 'tools/call' ? frame.params.name : frame.method);
          let result: unknown = {};
          if (frame.method === 'tools/list') result = { tools: [{ name: 'operate_start' }] };
          if (frame.method === 'tools/call') {
            const { name, arguments: args } = frame.params;
            if (name === 'operate_click' && holdClicks) continue;
            if (name === 'beeline_read_operation')
              result = { content: [{ type: 'text', text: '{"accepted":null,"completed":false}' }] };
            else {
              const id =
                name === 'operate_start'
                  ? `browser-${generation}-${++nextSession}`
                  : args.session_id;
              if (name === 'operate_start') sessions.add(id);
              result = {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      sessions.has(id)
                        ? { session_id: id, title: 'Local browser fixture' }
                        : { error: { code: 'stale_lease' } },
                    ),
                  },
                ],
                ...(!sessions.has(id) ? { isError: true } : {}),
              };
            }
          }
          peer.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
        }
      });
    });
    server.listen(path);
    await once(server, 'listening');
  };
  cleanups.push(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  return {
    path,
    methods,
    start,
    stop,
    holdClicks: () => {
      holdClicks = true;
    },
  };
}

async function helperFixture(path: string) {
  const attempts: Socket[] = [];
  const diagnostics: string[] = [];
  let spawns = 0;
  let linkDone!: Promise<unknown>;
  const transport = new HelperSquireTransport(
    '',
    (options) =>
      new StdioSquireMcpClient({
        ...options,
        spawn: (() => {
          spawns++;
          const input = new PassThrough();
          const output = new PassThrough();
          const child = Object.assign(new EventEmitter(), {
            pid: 123,
            stdin: input,
            stdout: output,
            stderr: new PassThrough(),
            kill: () => {
              input.end();
              return true;
            },
          });
          linkDone = runSquireBrokerLink({
            agentId: 'beeline-helper',
            socketPath: path,
            input,
            output,
            onShutdownSignal: () => {},
            logError: (message) => diagnostics.push(message),
            connect: (target) => {
              const peer = createConnection(target);
              attempts.push(peer);
              return peer;
            },
          }).then(({ ok }) => {
            child.emit('exit', ok ? 0 : 1);
          });
          return child;
        }) as never,
      }),
  );
  cleanups.push(async () => {
    transport.close();
    await linkDone;
  });
  const relay = new SquireTaskRelay(
    'agent',
    'room',
    '',
    async () => true,
    '',
    (callbacks) =>
      transport.acquire({
        scope: { agentId: 'agent', roomId: 'room' },
        onSpawn: callbacks.onSpawn,
        onExit: callbacks.onExit,
        onNotification: callbacks.onNotification,
        log: callbacks.onDiagnostic,
      }),
  );
  cleanups.push(() => relay.close());
  relay.activate(
    {
      agentId: 'agent',
      roomId: 'room',
      turnRequestId: 'turn',
      rootCommandId: 'task',
    } as AgentCommand,
    'item',
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    relay.requestMcp({
      roomId: 'room',
      requestId: 'turn',
      taskId: 'task',
      itemId: 'item',
      method: 'tools/call',
      params: { name, arguments: args },
    });
  return { call, attempts, diagnostics, spawns: () => spawns };
}

function body(result: unknown): { session_id: string; title: string } {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

describe('helper connection across Squire broker restarts', () => {
  it('recovers from two broker restarts without repair, helper restart or another facade', async () => {
    const broker = await brokerFixture();
    const helper = await helperFixture(broker.path);
    expect(body(await helper.call('operate_start')).title).toBe('Local browser fixture');
    for (let restart = 0; restart < 2; restart++) {
      await broker.stop();
      // The immediate successor must fail before the replacement listener is
      // published. This is the systemd restart gap the old relay could not cross.
      await vi.waitFor(() =>
        expect(helper.diagnostics.some((line) => /ENOENT|ECONNREFUSED/.test(line))).toBe(true),
      );
      helper.diagnostics.length = 0;
      // While the broker is away a call is answered at once as never sent; it
      // never waits for the broker and never reaches it.
      await expect(helper.call('operate_start')).rejects.toMatchObject({
        outcome: { accepted: false, completed: false },
      });
      await broker.start();
      // The socket's publication reconnects the link; its inventory read marks it ready.
      await vi.waitFor(() =>
        expect(broker.methods.filter((method) => method === 'tools/list')).toHaveLength(
          restart + 1,
        ),
      );
      const session = body(await helper.call('operate_start'));
      expect(
        body(await helper.call('operate_observe', { session_id: session.session_id })).title,
      ).toBe('Local browser fixture');
    }
    expect(helper.spawns()).toBe(1);
    expect(broker.methods.filter((method) => method === 'operate_start')).toHaveLength(3);
    expect(broker.methods.filter((method) => method === 'tools/list')).toHaveLength(2);
  });

  it('reports an action interrupted by a broker outage as possibly completed, never replays it, then permits a fresh session', async () => {
    const broker = await brokerFixture();
    const helper = await helperFixture(broker.path);
    const session = body(await helper.call('operate_start'));
    broker.holdClicks();
    const interrupted = helper
      .call('operate_click', { session_id: session.session_id })
      .catch((error) => error);
    await vi.waitFor(() => expect(broker.methods).toContain('operate_click'));
    await broker.stop();
    await vi.waitFor(() =>
      expect(helper.diagnostics.some((line) => /ENOENT|ECONNREFUSED/.test(line))).toBe(true),
    );
    // Its receipt cannot be read while the broker is away, and nothing waits for
    // it: the ambiguity is reported at once, and the action is never replayed.
    expect(await interrupted).toMatchObject({
      outcome: { cause: 'connection-lost', accepted: null, completed: false },
    });
    await broker.start();
    await vi.waitFor(() =>
      expect(broker.methods.filter((method) => method === 'tools/list')).toHaveLength(1),
    );
    expect(broker.methods.filter((method) => method === 'operate_click')).toHaveLength(1);
    expect(broker.methods.filter((method) => method === 'beeline_read_operation')).toHaveLength(0);
    const fresh = body(await helper.call('operate_start'));
    expect(body(await helper.call('operate_observe', { session_id: fresh.session_id })).title).toBe(
      'Local browser fixture',
    );
    expect(helper.spawns()).toBe(1);
  });

  it('refuses an absent initial broker and settles unsent calls without launching anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'squire-absent-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    output.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    const done = runSquireBrokerLink({
      agentId: 'beeline-helper',
      socketPath: join(dir, 'mcp.sock'),
      input,
      output,
      onShutdownSignal: () => {},
      logError: () => {},
    });
    expect(await done).toEqual({ ok: false });
    expect(frames).toMatchObject([
      { id: 1, error: { data: { outcome: 'not-sent', reconnect: 'failed' } } },
    ]);
    input.end();
  });
});
