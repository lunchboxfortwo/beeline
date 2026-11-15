import { afterEach, expect, it, vi } from 'vitest';
import { connectorOfferDepsFromEnv, squireShareEndpoint } from './read-only-mcp.js';
import { executeAgentTool } from './read-only-mcp-open-poll.js';
import { sessionToolRequest } from './session-tool-connection.js';

vi.mock('./session-tool-connection.js', () => ({ sessionToolRequest: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.mocked(sessionToolRequest).mockReset(); });
const reply = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
function sessionEnv() {
  vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', '');
  vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', '');
  vi.stubEnv('BEELINE_GRANT_RUNNER_FILE', '/fixture/endpoint');
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
}

it('discovers Squire tools through the existing app_tool route without a Registry installation', async () => {
  sessionEnv();
  vi.mocked(sessionToolRequest).mockResolvedValue({ tools: [{ name: 'list_credentials' }] });
  expect(JSON.parse(await executeAgentTool('app_tool', { app: 'registry-mcp:squire' }, 'call')))
    .toEqual({ tools: [{ name: 'list_credentials' }] });
  expect(sessionToolRequest).toHaveBeenCalledWith('/session', {
    placeId: 'room', action: 'mcp', app: 'registry-mcp:squire', tool: undefined, args: undefined,
  });
});

it.each(['', 'corner'])('uses the live session for Squire status and calls (corner: %s)', async corner => {
  sessionEnv();
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', corner);
  const fetcher = vi.spyOn(globalThis, 'fetch');
  vi.mocked(sessionToolRequest).mockResolvedValue(reply({ credentials: [] }));
  const deps = connectorOfferDepsFromEnv();
  expect(await deps.squireReach!()).toEqual({ reachable: true });
  expect(await deps.squireCall!('list_credentials', { fields: 'summary' })).toEqual({ credentials: [] });
  expect(sessionToolRequest).toHaveBeenLastCalledWith('/session', {
    placeId: corner || 'room', action: 'mcp', app: 'registry-mcp:squire',
    tool: 'list_credentials', args: { fields: 'summary' },
  });
  expect(fetcher).not.toHaveBeenCalled();
  vi.mocked(sessionToolRequest).mockRejectedValue(new Error('Squire call is not authorized for this task'));
  expect(await deps.squireReach!()).toEqual({ reachable: false, cause: 'Squire status probe was not authorized' });
});

it('opens the Squire browser-share handoff through the same live session', async () => {
  sessionEnv();
  const url = `https://share.example/s/${'a'.repeat(43)}/`;
  const expiresAt = Date.now() + 60_000;
  vi.mocked(sessionToolRequest).mockResolvedValue(reply({ url, expires_at: new Date(expiresAt).toISOString() }));
  expect(await squireShareEndpoint('browser-session')).toEqual({ url, expiresAt });
  expect(sessionToolRequest).toHaveBeenCalledWith('/session', {
    placeId: 'room', action: 'mcp', app: 'registry-mcp:squire', tool: 'operate_share', args: { session_id: 'browser-session' },
  });
  vi.mocked(sessionToolRequest).mockResolvedValue(reply({ url, expires_at: 'invalid' }));
  await expect(squireShareEndpoint('browser-session')).rejects.toThrow('no valid expiry');
});
