import { spawn } from 'node:child_process';
import { agentToolsFor } from './minimal-tool-surface.js';
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
      if (request.url === '/session') {
        response.end(JSON.stringify({ status: 200, value: { roomId: 'room-1', requestId: 'request-1', itemId: 'c'.repeat(64) } }));
        return;
      }
      seen.push({ url: request.url, authorization: request.headers.authorization, commandId: request.headers['x-beeline-command-id'], body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ allowed: false }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const spawn = vi.fn();
    const readFile = vi.fn();
    const tools: Tool[] = [];
    const extension = loadBridge(
      piMcpBridgeSource([
        {
          name: 'beeline-agent',
          command: 'agent',
          env: [
            { name: 'BEELINE_DAEMON_BASE_URL', value: `http://127.0.0.1:${port}` },
            { name: 'BEELINE_DAEMON_TOKEN', value: 'daemon-token' },
            { name: 'BEELINE_DAEMON_ROOM_ID', value: 'room-1' },
            { name: 'BEELINE_GRANT_RUNNER_URL', value: `http://127.0.0.1:${port}` },
            { name: 'BEELINE_GRANT_RUNNER_TOKEN', value: 'runner-token' },
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

it('lists concise purposes and retrieves only the requested Beeline schemas over stdio', async () => {
  const definitions = agentToolsFor(true, false, false, false, true, true, true);
  // Use the shipped catalog and echo call parameters so metadata and arguments are observable.
  const server = `
    const tools = JSON.parse(process.argv[1]);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      const result = method === 'tools/list' ? { tools }
        : { content: [{ type: 'text', text: JSON.stringify(params) }] };
      console.log(JSON.stringify({ id, result }));
    });
  `;
  const tools: Tool[] = [];
  loadBridge(piMcpBridgeSource([{ name: 'beeline-agent', command: process.execPath,
    args: ['-e', server, JSON.stringify(definitions)] }]), spawn, vi.fn())({
    registerTool: (tool: Tool) => tools.push(tool),
  });
  const execute = async (params: object) => {
    const result = await tools[0]!.execute('test-id', params) as { content: [{ text: string }] };
    return result.content[0].text;
  };
  const catalog = await execute({});
  expect(Buffer.byteLength(catalog)).toBeLessThanOrEqual(2500);
  expect(catalog).toContain('describe:');
  expect(catalog).toContain('query:');
  for (const tool of definitions) expect(catalog.split('\n').some(line => line.startsWith(tool.name + ' — '))).toBe(true);
  const selected = definitions.filter(tool => ['read', 'message'].includes(tool.name));
  const full = (tool: typeof definitions[number]) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  });
  expect(JSON.parse(await execute({ describe: 'message, read' }))).toEqual(selected.map(full));
  expect(JSON.parse(await execute({ describe: 'unknown' }))).toEqual([]);
  expect(JSON.parse(await execute({ query: 'APPROVAL' }))).toEqual(definitions.filter(tool =>
    (tool.name + ' ' + tool.description).toLowerCase().includes('approval')).map(full));
  expect(JSON.parse(await execute({ name: 'read', arguments: { facet: 'session' } }))).toEqual({
    name: 'read', arguments: { facet: 'session' }, _meta: { beelineToolCallId: 'test-id' },
  });
});

it('keeps both ends of an oversized third-party call or tool error', async () => {
  const server = `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, params } = JSON.parse(line);
      const result = { content: [{ type: 'text', text: 'START' + '界'.repeat(20000) + 'END' }],
        isError: params?.name === 'fail' };
      console.log(JSON.stringify({ id, result }));
    });
  `;
  const tools: Tool[] = [];
  loadBridge(piMcpBridgeSource([{ name: 'codegraph', command: process.execPath, args: ['-e', server] }]),
    spawn, vi.fn())({ registerTool: (tool: Tool) => tools.push(tool) });
  const result = await tools[0]!.execute('call', { name: 'search' }) as { content: [{ text: string }] };
  const text = result.content[0].text;
  expect(text).toMatch(/^START.*Output truncated.*END$/s);
  expect(Buffer.byteLength(text)).toBeLessThan(13000);
  await expect(tools[0]!.execute('call', { name: 'fail' })).rejects.toThrow(text);
});
