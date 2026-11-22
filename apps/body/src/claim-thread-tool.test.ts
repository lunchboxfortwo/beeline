import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { callAgentTool } from './read-only-mcp-open-poll.js';

it('claims the current thread by default and an addressed thread from a parent chat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beeline-claim-thread-'));
  const context = join(directory, 'turn.json');
  await writeFile(context, JSON.stringify({ roomId: 'parent-chat', requestId: 'command' }));
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: 'write', createdAt: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'https://daemon.example');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  const sent = () => {
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [URL, { body: string }];
    return { operation: String(url).split('/').pop(), input: JSON.parse(init.body) };
  };
  try {
    await callAgentTool('claim_thread', {}, 'claim-1');
    expect(sent()).toEqual({ operation: 'becomeImplementer', input: { roomId: 'parent-chat', requestId: 'command' } });
    await callAgentTool('claim_thread', { address: 'thread-1' }, 'claim-2');
    expect(sent()).toEqual({ operation: 'becomeImplementer',
      input: { roomId: 'parent-chat', requestId: 'command', cornerId: 'thread-1' } });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true });
  }
});
