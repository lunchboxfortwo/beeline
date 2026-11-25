import { afterEach, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends concurrent replies with only their quotes and the current place', async () => {
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent');
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'thread');
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'fixture');
  const inputs: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    inputs.push(JSON.parse(String(init.body)));
    return Response.json({ id: 'result', createdAt: 1 });
  }));
  await Promise.all(['first', 'second'].map(quoteMsgId =>
    callAgentTool('message', { type: 'reply', quoteMsgId, text: 'Completed' }, quoteMsgId)));
  expect(inputs).toEqual(expect.arrayContaining(['first', 'second'].map(quoteMsgId =>
    ({ roomId: 'thread', type: 'reply', quoteMsgId, text: 'Completed' }))));
});
