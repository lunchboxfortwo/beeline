import * as sessionTools from './session-tool-connection.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { authorizeResourceMessage } from './resource-mcp-facade.js';

it.each(['codegraph', 'beeline'])('connects %s before a prompt and gates its tool calls', async target => {
  const root = await mkdtemp(join(tmpdir(), 'resource-facade-'));
  const command = { roomId: 'room', requestId: 'prompt', itemId: 'd'.repeat(64) };
  let current: typeof command | null = null;
  let cancelled = false;
  let commandReads = 0;
  const calls: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/session') {
      commandReads++;
      response.end(JSON.stringify(current));
      return;
    }
    calls.push({
      path: request.url,
      commandId: request.headers['x-beeline-command-id'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(cancelled ? 403 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(cancelled ? { error: 'command turn cancelled' } : { allowed: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  const authPath = join(root, 'auth.json');
  const started = join(root, 'upstream-started');
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./resource-mcp-facade.ts', import.meta.url))], {
    env: { ...process.env, BEELINE_RESOURCE_TARGET: target, BEELINE_RESOURCE_AUTH_FILE: authPath,
      FIXTURE_MCP_STARTED: started,
      BEELINE_GRANT_RUNNER_URL: baseUrl, BEELINE_GRANT_RUNNER_TOKEN: 'fixture',
      BEELINE_RESOURCE_LAUNCH: JSON.stringify({ command: process.execPath, args: ['-e', `
        require('node:fs').writeFileSync(process.env.FIXTURE_MCP_STARTED, '');
        let initialized = false;
        let toolCalls = 0;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const { id, method } = JSON.parse(line);
          if (method === 'notifications/initialized') initialized = true;
          if (id === undefined) return;
          const result = method === 'initialize' ? { protocolVersion: '2024-11-05' }
            : method === 'tools/list' ? { tools: initialized ? [{ name: 'lookup' }] : [] }
            : method === 'tools/call' ? { toolCalls: ++toolCalls } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
        });
      `] }) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const output = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  let id = 0;
  const request = async (method: string, params?: object) => {
    const reply = once(output, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    const [line] = await Promise.race([
      reply,
      closed.then(() => { throw new Error(`Resource facade exited while waiting for ${method}`); }),
    ]);
    const message = JSON.parse(line);
    expect(message.id).toBe(id);
    return message;
  };
  try {
    expect(await request('initialize', { protocolVersion: '2024-11-05' })).toHaveProperty('result.protocolVersion', '2024-11-05');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    expect(await request('ping')).toHaveProperty('result', {});
    expect(await request('tools/list')).toHaveProperty('result.tools', []);
    expect(commandReads).toBe(0);

    await writeFile(authPath, JSON.stringify({ baseUrl, daemonToken: 'test', placeId: 'room' }));
    const tool = { name: 'lookup' };
    expect(await request('tools/call', tool)).toHaveProperty('error.code', -32001);
    expect(calls).toEqual([]);
    await expect(access(started)).rejects.toMatchObject({ code: 'ENOENT' });

    current = command;
    expect(await request('tools/call', tool)).toHaveProperty('result.toolCalls', 1);
    expect(await request('tools/list')).toHaveProperty('result.tools', [{ name: 'lookup' }]);
    cancelled = true;
    expect(await request('tools/call', tool)).toHaveProperty('error.code', -32001);
    expect(await closed).toEqual([1, null]);
    const authorization = {
      path: '/v1/daemon/operations/authorizeResourceCall',
      commandId: command.itemId,
      body: { roomId: command.roomId, requestId: command.requestId, target, operation: 'lookup' },
    };
    expect(calls).toEqual([
      { ...authorization, body: { ...authorization.body, consume: false } },
      authorization,
      { ...authorization, body: { roomId: command.roomId, requestId: command.requestId, target, consume: false } },
      authorization,
    ]);
    expect(commandReads).toBe(5);
  } finally {
    child.kill('SIGTERM');
    await closed;
    output.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['command output authority rejected', 'command turn cancelled', 'command already completed'])(
  'ends a stale MCP generation on %s instead of authorizing queued tool calls', async error => {
    const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
    const calls: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        if (request.url === '/session') {
          response.end(JSON.stringify({ roomId: 'room', requestId: 'cancelled-command' }));
          return;
        }
        calls.push(JSON.parse(body));
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(join(root, 'auth.json'), JSON.stringify({
      baseUrl, daemonToken: 'test-token', placeId: 'room',
    }));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./resource-mcp-facade.ts', import.meta.url))], {
      env: { ...process.env, BEELINE_RESOURCE_TARGET: 'squire', BEELINE_GRANT_RUNNER_URL: baseUrl, BEELINE_GRANT_RUNNER_TOKEN: 'fixture',
        BEELINE_RESOURCE_AUTH_FILE: join(root, 'auth.json'),
        BEELINE_RESOURCE_LAUNCH: JSON.stringify({ url: `${baseUrl}/never-called` }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const exited = once(child, 'exit');
      child.stdin.end(Array.from({ length: 4 }, (_, id) =>
        JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'lookup' } })).join('\n') + '\n');
      await exited;
      expect(calls).toEqual([expect.objectContaining({ requestId: 'cancelled-command', operation: 'lookup' })]);
    } finally {
      child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

// A resource that ignores graceful shutdown must still end with its facade.
it.each(['revocation', 'stdin close', 'SIGTERM'] as const)('kills the resource transport on %s', async ending => {
  const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
  let revoked = false;
  let calls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/session') {
      response.end(JSON.stringify({ roomId: 'room', requestId: 'command' }));
      return;
    }
    calls++;
    response.writeHead(revoked ? 403 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(revoked ? { error: 'command output authority rejected' } : { allowed: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const authPath = join(root, 'auth.json');
  await writeFile(authPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, daemonToken: 'test', placeId: 'room' }));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./resource-mcp-facade.ts', import.meta.url))], {
    env: { ...process.env, BEELINE_RESOURCE_TARGET: 'files', BEELINE_RESOURCE_AUTH_FILE: authPath,
      BEELINE_GRANT_RUNNER_URL: `http://127.0.0.1:${port}`, BEELINE_GRANT_RUNNER_TOKEN: 'fixture',
      BEELINE_RESOURCE_LAUNCH: JSON.stringify({ command: process.execPath, args: ['-e', `
        process.on('SIGTERM', () => {});
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const message = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pid: process.pid } }) + '\\n');
        });
      `] }) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = createInterface({ input: child.stdout });
  let resourcePid: number | undefined;
  try {
    const initialized = once(output, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    expect(JSON.parse((await initialized)[0]).result.serverInfo.name).toBe('beeline-resource-facade');
    expect(calls).toBe(0);
    const reply = once(output, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    resourcePid = JSON.parse((await reply)[0]).result.pid;
    const exited = once(child, 'exit');
    if (ending === 'revocation') {
      revoked = true;
      child.stdin.write(Array.from({ length: 4 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id: id + 3, method: 'tools/call' })).join('\n') + '\n');
    } else if (ending === 'stdin close') child.stdin.end();
    else child.kill('SIGTERM');
    await exited;
    expect(calls).toBe(ending === 'revocation' ? 3 : 2);
    expect(() => process.kill(resourcePid!, 0)).toThrow();
  } finally {
    child.kill('SIGKILL');
    if (resourcePid) { try { process.kill(resourcePid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    output.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps permission denial per-call and refuses inactive commands without HTTP', async () => {
  const root = await mkdtemp(join(process.cwd(), '.resource-facade-'));
  const authPath = join(root, 'auth.json');
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  let calls = 0;
  const fetchImpl = (async (_url, init) => {
    expect(new Headers(init?.headers).get('x-beeline-command-id')).toBe(calls ? 'd'.repeat(64) : null);
    calls++;
    return new Response(JSON.stringify({ allowed: calls > 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await writeFile(authPath, JSON.stringify({ baseUrl: 'https://unused.test', daemonToken: 'test', placeId: 'room' }));
    const command = vi.spyOn(sessionTools, 'sessionCommandContext').mockResolvedValue({ roomId: 'room', requestId: 'command' });
    expect(await authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).toBe(false);
    command.mockResolvedValue({ roomId: 'room', requestId: 'request', itemId: 'd'.repeat(64) });
    expect(await authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).toBe(true);
    command.mockResolvedValue(undefined);
    expect(await authorizeResourceMessage(message, 'files', authPath, true, fetchImpl)).toBe(false);
    expect(calls).toBe(2);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});
