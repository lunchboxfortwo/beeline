import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionToolRequest, transportCause } from './session-tool-connection.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
});
async function runner(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const useRunner = (url: string) => {
  vi.stubEnv('BEELINE_GRANT_RUNNER_FILE', '');
  vi.stubEnv('BEELINE_GRANT_RUNNER_URL', url);
  vi.stubEnv('BEELINE_GRANT_RUNNER_TOKEN', 'token');
};

it('returns the runner answer and its refusal text', async () => {
  useRunner(
    await runner((request, response) => {
      response.statusCode = request.url === '/run' ? 200 : 403;
      response.end(
        JSON.stringify(request.url === '/run' ? { grantId: 'g' } : { error: 'not this chat' }),
      );
    }),
  );
  await expect(sessionToolRequest('/run', {})).resolves.toEqual({ grantId: 'g' });
  await expect(sessionToolRequest('/session', {})).rejects.toThrow('not this chat');
});

// Repro E: the loopback request ended only by undici's own 300 s headers limit,
// reported as a bare failure. The transport's cause is now named.
it('names the transport cause when the runner answer never arrives', async () => {
  useRunner('http://127.0.0.1:9');
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    });
  });
  await expect(sessionToolRequest('/run', {})).rejects.toThrow(
    'Beeline session tools did not answer run (UND_ERR_HEADERS_TIMEOUT); the outcome is unknown',
  );
});

it('settles on the runner closing the connection without an answer', async () => {
  useRunner(await runner((request) => request.socket.destroy()));
  const error = await sessionToolRequest('/session', {}).catch((failure: Error) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    /^Beeline session tools did not answer session \((UND_ERR_SOCKET|ECONNRESET)\); the outcome is unknown$/,
  );
});

it('settles at once when no runner listens', async () => {
  const closed = await runner(() => undefined);
  await new Promise<void>((done) => servers.pop()!.close(() => done()));
  useRunner(closed);
  await expect(sessionToolRequest('/run', {})).rejects.toThrow(
    '(ECONNREFUSED); the outcome is unknown',
  );
});

it('falls back to the innermost message when no code is present', () => {
  expect(transportCause(new TypeError('fetch failed'))).toBe('fetch failed');
  expect(transportCause(new Error('outer', { cause: new Error('inner reason') }))).toBe(
    'inner reason',
  );
});

it('preserves a streamed refusal and reports an interrupted stream as an unknown outcome', async () => {
  useRunner(
    await runner((request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        JSON.stringify(
          request.url === '/run'
            ? { type: 'result', status: 400, value: { error: 'not this chat' } }
            : { type: 'output', stream: 'stderr', text: 'working\n' },
        ) + '\n',
      );
    }),
  );
  await expect(sessionToolRequest('/run', {})).rejects.toThrow('not this chat');
  const lines: string[] = [];
  await expect(sessionToolRequest('/session', {}, (line) => lines.push(line.text))).rejects.toThrow(
    'the outcome is unknown',
  );
  expect(lines).toEqual(['working\n']);
});
