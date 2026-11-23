import { readFile } from 'node:fs/promises';
import type { GrantRunnerEndpoint } from './grant-runner.js';
import { ask } from './wait.js';

/** The loopback listener may finish starting after the first session opens. */
export async function sessionToolConnection(): Promise<GrantRunnerEndpoint> {
  if (process.env.BEELINE_GRANT_RUNNER_FILE) {
    const value = JSON.parse(await readFile(process.env.BEELINE_GRANT_RUNNER_FILE, 'utf8')) as GrantRunnerEndpoint;
    if (value.url && value.token) return value;
  }
  const url = process.env.BEELINE_GRANT_RUNNER_URL;
  const token = process.env.BEELINE_GRANT_RUNNER_TOKEN;
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

export async function sessionToolRequest(route: string, input: unknown): Promise<unknown> {
  const endpoint = await sessionToolConnection();
  let response: Response;
  let body: { error?: string };
  try {
    // stdout/stderr here belong to the MCP protocol and the agent; no wait line.
    response = await ask({ url: new URL(route, `${endpoint.url}/`), peer: 'Beeline session tools', report: false }, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    body = await response.json() as { error?: string };
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    // The helper may still be doing the work; only the answer was lost.
    throw new Error(`Beeline session tools did not answer ${route.replace(/^\//, '')} ` +
      `(${transportCause(error)}); the outcome is unknown`, { cause: error });
  }
  if (!response.ok) throw new Error(body.error ?? `Session tool failed (${response.status})`);
  return body;
}
