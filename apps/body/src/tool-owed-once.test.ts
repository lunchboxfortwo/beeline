import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp-open-poll.js';
import { withToolOwedContext } from './read-only-mcp.js';

const room = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('lists owed mentions once per turn and only for the place in use', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'owed-')), 'turn.json');
  writeFileSync(file, JSON.stringify({ generationId: `gen-${Math.random()}`, roomId: room }));
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'local-test');
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', room);
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', file);
  const owed = [
    { roomId: room, messageId: 'here', memberId: 'member' },
    { roomId: other, messageId: 'there', memberId: 'member' },
  ];
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (headers['x-beeline-tool-result'] === '1') expect(headers['x-beeline-place']).toBe(room);
    return Response.json({ _beelineToolResult: { rooms: [] }, _beelineOwedMentions: owed });
  });
  vi.stubGlobal('fetch', fetch);
  const first = await withToolOwedContext(() => callAgentTool('read', { facet: 'addresses' }, 'once'));
  expect(first.content.map(block => block.text)).toEqual([
    JSON.stringify({ rooms: [] }),
    JSON.stringify({ owedMentions: [owed[0]] }),
  ]);
  const second = await withToolOwedContext(() => callAgentTool('read', { facet: 'addresses' }, 'again'));
  expect(second.content).toEqual([{ type: 'text', text: JSON.stringify({ rooms: [] }) }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  const headers = (call: number) => (fetch.mock.calls[call]?.[1] as RequestInit).headers as Record<string, string>;
  expect(headers(0)['x-beeline-tool-result']).toBe('1');
  expect(headers(1)['x-beeline-tool-result']).toBeUndefined();
});
