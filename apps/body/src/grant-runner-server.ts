import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GrantCommandRunner } from './grant-runner.js';
import { listen, type Listening } from './wait.js';

export interface GrantRunnerEndpoint {
  url: string;
  token: string;
}

/**
 * The loopback door the in-sandbox MCP server knocks on. bubblewrap shares the
 * network namespace (see `bwrap-sandbox.ts`), so 127.0.0.1 reaches the daemon;
 * a per-process random bearer token keeps other local users out.
 */
export class GrantRunnerServer {
  private server?: Listening;
  private endpoint?: GrantRunnerEndpoint;

  constructor(
    private readonly runner: GrantCommandRunner,
    /** The `workspace` tool: the agent's own checkout, made only when it asks. */
    private readonly workspace?: (placeId: string, parentRoomId?: string) => Promise<string>,
    private readonly session?: (
      placeId: string,
      input: {
        action?: unknown;
        prepare?: unknown;
        app?: unknown;
        tool?: unknown;
        args?: unknown;
        operation?: unknown;
        commandId?: unknown;
        requestId?: unknown;
        input?: unknown;
      },
    ) => Promise<unknown>,
    private readonly currentSession?: (placeId: string, resetId: string | string[] | undefined) => boolean,
  ) {}

  async start(): Promise<GrantRunnerEndpoint> {
    if (this.endpoint) return this.endpoint;
    const token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      void this.handle(request, response, token);
    });
    const listening = await listen(server, { port: 0, host: '127.0.0.1' });
    server.unref?.();
    const address = server.address() as AddressInfo;
    this.server = listening;
    this.endpoint = { url: `http://127.0.0.1:${address.port}`, token };
    return this.endpoint;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    await server?.close();
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    token: string,
  ): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'grant runner token required' });
      return;
    }
    if (
      request.method !== 'POST' ||
      !['/run', '/workspace', '/session'].includes(request.url ?? '')
    ) {
      send(404, { error: 'not found' });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.flushHeaders();
    const frame = (value: unknown) => {
      if (!response.destroyed && !response.writableEnded)
        response.write(`${JSON.stringify(value)}\n`);
    };
    const finish = (status: number, value: unknown) => {
      frame({ type: 'result', status, value });
      response.end();
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const placeId = request.url === '/run' ? body.roomId : body.placeId;
      if (typeof placeId === 'string' && this.currentSession &&
          !this.currentSession(placeId, request.headers['x-beeline-place-reset']))
        throw new Error('this daemon is not serving that chat');
      if (request.url === '/session') {
        if (!this.session || typeof body.placeId !== 'string')
          throw new Error('Session tools unavailable');
        finish(200, await this.session(body.placeId, body));
      } else if (request.url === '/workspace') {
        if (!this.workspace || typeof body.placeId !== 'string')
          throw new Error('workspace is unavailable here');
        finish(200, {
          text: await this.workspace(
            body.placeId,
            typeof body.parentRoomId === 'string' ? body.parentRoomId : undefined,
          ),
        });
      } else {
        finish(
          200,
          await this.runner.run(
            { roomId: body.roomId, argv: body.argv, stdin: body.stdin, secrets: body.secrets },
            (output) => frame({ type: 'output', ...output }),
          ),
        );
      }
    } catch (error) {
      if (request.url === '/workspace')
        finish(200, {
          text: `The checkout could not be made: ${error instanceof Error ? error.message : String(error)}`,
        });
      else finish(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
