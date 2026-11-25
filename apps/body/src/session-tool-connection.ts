import type { GrantOutputLine } from './grant-runner-output.js';
import { readFile } from 'node:fs/promises';
import type { GrantRunnerEndpoint } from './grant-runner.js';
import { ask } from './wait.js';

/** The loopback listener may finish starting after the first session opens. */
export async function sessionToolConnection(env: NodeJS.ProcessEnv = process.env): Promise<GrantRunnerEndpoint> {
  if (env.BEELINE_GRANT_RUNNER_FILE) {
    const value = JSON.parse(
      await readFile(env.BEELINE_GRANT_RUNNER_FILE, 'utf8'),
    ) as GrantRunnerEndpoint;
    if (value.url && value.token) return value;
  }
  const url = env.BEELINE_GRANT_RUNNER_URL;
  const token = env.BEELINE_GRANT_RUNNER_TOKEN;
  if (!url || !token) throw new Error('Session tools are not available yet');
  return { url, token };
}

/** The transport's own reason a request ended without an answer, e.g. `UND_ERR_HEADERS_TIMEOUT`. */
export function transportCause(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  // Follow the cause chain (undici wraps its code in `fetch failed`); a few links suffice.
  for (let value = error, link = 0; value && typeof value === 'object' && link < 5; link++) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    if (value instanceof Error && value.message) message = value.message;
    value = (value as { cause?: unknown }).cause;
  }
  return message;
}

async function streamResult(
  response: Response,
  output: (line: GrantOutputLine) => void,
): Promise<{ status: number; body: unknown }> {
  if (!response.body) throw new Error('Session tool stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Session tool stream ended before its result');
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const value = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (value.type === 'result' && Number.isInteger(value.status))
          return { status: value.status, body: value.value };
        if (
          value.type !== 'output' ||
          !['stdout', 'stderr'].includes(value.stream) ||
          typeof value.text !== 'string'
        )
          throw new Error('Session tool stream returned an invalid frame');
        output({ stream: value.stream, text: value.text });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function sessionToolRequest(
  route: string,
  input: unknown,
  output: (line: GrantOutputLine) => void = (line) => {
    process.stderr.write(line.text);
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const endpoint = await sessionToolConnection(env);
  let status: number;
  let body: { error?: string };
  const context = process.env.BEELINE_TURN_CONTEXT_FILE;
  try {
    const response = await ask(
      { url: new URL(route, `${endpoint.url}/`) },
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json',
          ...(context ? { 'x-beeline-turn-context': encodeURIComponent(context) } : {}),
        },
        body: JSON.stringify(input),
      },
    );
    if (response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
      const result = await streamResult(response, output);
      status = result.status;
      body = result.body as { error?: string };
    } else {
      status = response.status;
      body = (await response.json()) as { error?: string };
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new Error(
      `Beeline session tools did not answer ${route.replace(/^\//, '')} ` +
        `(${transportCause(error)}); the outcome is unknown`,
      { cause: error },
    );
  }
  if (status < 200 || status >= 300)
    throw new Error(body.error ?? `Session tool failed (${status})`);
  return body;
}

export interface SessionCommandContext {
  roomId: string;
  requestId: string;
  taskId?: string;
  itemId?: string;
  promptSectionIds?: readonly string[];
}

export async function sessionCommandContext(
  requestId?: string,
  placeId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionCommandContext | undefined> {
  placeId ??= env.BEELINE_DAEMON_CORNER_ID || env.BEELINE_DAEMON_ROOM_ID;
  if (!placeId || !(env.BEELINE_GRANT_RUNNER_URL || env.BEELINE_GRANT_RUNNER_FILE)) return;
  const context = await sessionToolRequest('/session', { placeId, action: 'command', requestId }, undefined, env);
  return (context ?? undefined) as SessionCommandContext | undefined;
}
