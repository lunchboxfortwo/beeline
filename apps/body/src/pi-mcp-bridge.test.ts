import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { piMcpBridgeSource } from './pi-mcp-bridge.js';
import { answer, ask, runOwned, type OwnedCommand } from './wait.js';

type Tool = { execute: (id: string, args: object) => Promise<unknown> };
/** The generated extension with its imports supplied: readFile and the standalone owners, spawning through `spawn`. */
function loadBridge(source: string, spawn: unknown, readFile: unknown) {
  const body = source
    .replace(/^import .* from (?:'node:[^']+'|"data:[^"]+");\n/gm, '')
    .replace('export default function', 'return function');
  const owned = (command: OwnedCommand) => runOwned(command, { spawn: spawn as never });
  return new Function('readFile', 'ask', 'answer', 'runOwned', body)(readFile, ask, answer, owned);
}

it('loads the Pi extension and permits prompts without contacting an unresponsive MCP child', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: { write: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
  });
  const spawn = vi.fn((..._args: unknown[]) => child);
  const tools: Tool[] = [];
  const on = vi.fn();
  const extension = loadBridge(
    piMcpBridgeSource([{ name: 'optional', command: 'fixture' }]),
    spawn,
    vi.fn(),
  );
  await extension({ registerTool: (tool: Tool) => tools.push(tool), on });
  expect(spawn).not.toHaveBeenCalled();
  expect(on).not.toHaveBeenCalled();
  expect(tools).toHaveLength(1);
  // Only the agent's explicit tool operation opens discovery. A hung child
  // affects that tool call, never loading the extension or starting a prompt.
  const discovery = tools[0]!.execute('list', {});
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: false });
  expect(child.stdin.write).toHaveBeenCalledTimes(2);
  const failed = expect(discovery).rejects.toThrow('exited before answering');
  child.emit('close', 1, null);
  await failed;
});

it('asks the Beeline server before a Squire call and keeps its refusal', async () => {
  const seen: Array<{ url?: string; authorization?: string; commandId: unknown; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({ url: request.url, authorization: request.headers.authorization, commandId: request.headers['x-beeline-command-id'], body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ allowed: false }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const spawn = vi.fn();
    const readFile = vi.fn(async () =>
      JSON.stringify({ roomId: 'room-1', requestId: 'request-1', itemId: 'c'.repeat(64) }),
    );
    const tools: Tool[] = [];
    const extension = loadBridge(
      piMcpBridgeSource([
        {
          name: 'beeline-agent',
          command: 'agent',
          env: [
            { name: 'BEELINE_DAEMON_BASE_URL', value: `http://127.0.0.1:${port}` },
            { name: 'BEELINE_DAEMON_TOKEN', value: 'daemon-token' },
            { name: 'BEELINE_TURN_CONTEXT_FILE', value: '/turn.json' },
          ],
        },
        {
          name: 'squire',
          command: 'squire-route',
          env: [{ name: 'TRUSTY_SQUIRE_BROKER_SOCKET', value: '/broker.sock' }],
        },
      ]),
      spawn,
      readFile,
    );
    await extension({ registerTool: (tool: Tool) => tools.push(tool), on: vi.fn() });
    await expect(tools[1]!.execute('call', { name: 'operate_start' })).rejects.toThrow(
      'Squire requires approval from its owner',
    );
    expect(seen).toEqual([
      {
        url: '/v1/daemon/operations/authorizeSquireCall',
        authorization: 'Bearer daemon-token',
        commandId: 'c'.repeat(64),
        body: JSON.stringify({ roomId: 'room-1', requestId: 'request-1' }),
      },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    server.close();
  }
});
