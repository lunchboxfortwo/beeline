import { createServer } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { shareChromiumPage, type ChromiumPage } from './browser-share.js';
import { privateSocketPath, preparePrivateSocketDirectory } from './local-socket.js';
import { ask, listen, type Listening } from './wait.js';

export function browserShareHostPath(stateRoot: string, agentId: string): string {
  return privateSocketPath(
    JSON.stringify(['browser-share', resolve(stateRoot), process.pid, agentId]),
  );
}

type ShareRequest = {
  page: ChromiumPage;
  shareId: string;
  roomId: string;
  serverBaseUrl: string;
  daemonToken: string;
};

/** One socket per hosted agent, outside short lived model turn sandboxes. */
export class BrowserShareHost {
  private server?: Listening;
  constructor(readonly socketPath: string) {}

  async start(): Promise<void> {
    await preparePrivateSocketDirectory(this.socketPath);
    rmSync(this.socketPath, { force: true });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > 65_536) socket.destroy();
      });
      // The client's half-close is the whole request; a close or error before it is a lost one.
      socket.on('end', () => {
        void (async () => {
          const request = JSON.parse(text) as ShareRequest;
          if (
            !request.page?.webSocketDebuggerUrl ||
            !request.shareId ||
            !request.roomId ||
            !request.serverBaseUrl ||
            !request.daemonToken
          )
            throw new Error('Invalid browser share request');
          await shareChromiumPage({
            page: request.page,
            shareId: request.shareId,
            serverBaseUrl: request.serverBaseUrl,
            daemonToken: request.daemonToken,
            // The hosted share can outlive its model/MCP process; this closed
            // session-end receipt has its own lifetime, without a turn source.
            onEnded: async () => {
              await ask(
                {
                  url: new URL('/v1/daemon/operations/endComputerSession', request.serverBaseUrl),
                },
                {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${request.daemonToken}`,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({ roomId: request.roomId, sessionId: request.page.id }),
                },
              ).catch(() => {});
            },
          });
          socket.end(JSON.stringify({ ok: true }));
        })().catch((error: unknown) =>
          socket.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          ),
        );
      });
    });
    this.server = await listen(server, this.socketPath);
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.close();
    rmSync(this.socketPath, { force: true });
  }
}

export async function startHostedBrowserShare(
  socketPath: string,
  request: ShareRequest,
): Promise<void> {
  const output = await ask<string>(
    { socket: socketPath, peer: 'browser share host', framing: 'eof' },
    JSON.stringify(request),
  );
  const result = JSON.parse(output) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error ?? 'Browser share host failed');
}
