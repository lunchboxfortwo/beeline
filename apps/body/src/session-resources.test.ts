import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { brokerRequest } from './registry-mcp.js';
import { SessionResources } from './session-resources.js';

vi.mock('./registry-mcp.js', () => ({ brokerRequest: vi.fn(async (_socket, request) => {
  const rpc = JSON.parse(request.line);
  return rpc.id === undefined ? [] : [JSON.stringify({ id: rpc.id, result: rpc.method === 'tools/list' ? { tools: [{ name: 'lookup' }] } : {} })];
}) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-resources-')); roots.push(root);
  const cachePath = join(root, 'context.json');
  const execute = vi.fn(() => new Promise(() => {}));
  const configured = vi.fn(async () => {});
  const resources = new SessionResources({ api: { execute } as unknown as DaemonApiClient,
    placeId: 'room', agentId: 'agent', workspaceId: 'workspace', cachePath, brokerSocket: '/fixture', configured });
  return { resources, execute, configured, cachePath };
}

it('loads independent capabilities while another optional read hangs and never persists grants', async () => {
  const f = await fixture();
  f.execute.mockImplementation(name => name === 'listAgentGrants'
    ? Promise.resolve({ grants: [{ kind: 'path', target: '/approved', status: 'approved' }] })
    : new Promise(() => {}));
  f.resources.refresh();
  await vi.waitFor(() => expect(f.resources.read()).toMatchObject({ status: { configuration: 'loading', grants: 'ready' } }));
  await vi.waitFor(async () => expect(JSON.parse(await readFile(f.cachePath, 'utf8'))).not.toHaveProperty('grants'));
  expect(f.configured).not.toHaveBeenCalled();
});

it('returns a tool error until a Registry route loads, then attaches it to the same session tools', async () => {
  const f = await fixture(), turn = { roomId: 'room', requestId: 'item' };
  await expect(f.resources.mcp({ app: 'registry-mcp:search' }, turn)).rejects.toThrow('not available yet');
  f.execute.mockImplementation(name => name === 'getAgentConfiguration' ? Promise.resolve({ commands: [], yoloMode: false, isReviewer: false,
    registryMcpRoutes: [{ connectorId: 'connector', serverName: 'search', target: 'registry-mcp:search', routeName: 'search' }] }) : new Promise(() => {}));
  f.resources.refresh();
  await vi.waitFor(() => expect(f.resources.read()).toMatchObject({ status: { configuration: 'ready' } }));
  await expect(f.resources.mcp({ app: 'registry-mcp:search' }, turn)).resolves.toEqual({ tools: [{ name: 'lookup' }] });
  await f.resources.mcp({ app: 'registry-mcp:search', tool: 'lookup', args: { query: 'answer' } }, turn);
  expect(brokerRequest).toHaveBeenLastCalledWith('/fixture', expect.objectContaining({ turn,
    line: expect.stringContaining('"method":"tools/call"') }));
  expect(vi.mocked(brokerRequest).mock.calls.filter(([, input]) => JSON.parse(input.line).method === 'initialize')).toHaveLength(1);
});
