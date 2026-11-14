import { readFile } from 'node:fs/promises';
import type { GrantRunnerEndpoint } from './grant-runner.js';

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

export async function sessionToolRequest(route: string, input: unknown): Promise<unknown> {
  const endpoint = await sessionToolConnection();
  const response = await fetch(new URL(route, `${endpoint.url}/`), {
    method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Session tool failed (${response.status})`);
  return body;
}
