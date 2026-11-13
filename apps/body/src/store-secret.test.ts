import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner, GrantRunnerServer, operatorSecretResolver } from './grant-runner.js';
import { callAgentTool } from './read-only-mcp.js';
import { agentToolsFor } from './minimal-tool-surface.js';
import { isBeelineAgentMcpPermissionRequest } from './read-only-policy.js';

const secret = 'opaque-test-value-with-no-provider-format';
afterEach(() => vi.unstubAllEnvs());

it('stores an agent-supplied secret and injects it into the next granted command without returning it', async () => {
  const root = await mkdtemp(join(process.cwd(), '.store-secret-test-'));
  const calls: unknown[] = [];
  const execute = vi.fn(async (operation: string, input: unknown) => {
    calls.push({ operation, input });
    if (operation === 'listTurnAgentGrants') return { grants: [{
      grantId: 'grant', workspaceId: 'workspace', roomId: 'room', kind: 'command',
      target: '/usr/bin/printenv FLY_TOKEN --with FLY_TOKEN', status: 'approved', requestedBy: 'owner',
    }] };
    return {};
  }) as DaemonApiClient['execute'];
  const env = { XDG_CONFIG_HOME: root, HOME: root, PATH: process.env.PATH };
  const runner = new GrantCommandRunner({ api: { execute }, agentId: 'agent', env });
  runner.register('room', {
    workspaceId: 'workspace', cwd: root, writePolicy: () => ({ surface: 'corner' }),
    turn: () => ({ requestId: 'request', generationId: 'generation' }),
  });
  const server = new GrantRunnerServer(runner);
  try {
    const endpoint = await server.start();
    vi.stubEnv('XDG_CONFIG_HOME', root);
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    vi.stubEnv('BEELINE_GRANT_RUNNER_URL', endpoint.url);
    vi.stubEnv('BEELINE_GRANT_RUNNER_TOKEN', endpoint.token);
    const stored = await callAgentTool('store_secret', { name: 'FLY_TOKEN', value: secret }, 'store');
    expect(stored).toContain('stored secret FLY_TOKEN');
    expect(calls).toEqual([]); // Storage makes no server operation or ledger entry.
    expect(JSON.parse(await readFile(join(root, 'beeline', 'secrets.json'), 'utf8'))).toEqual({ FLY_TOKEN: secret });
    expect((await stat(join(root, 'beeline', 'secrets.json'))).mode & 0o777).toBe(0o600);
    expect(await operatorSecretResolver(env)('FLY_TOKEN')).toBe(secret);
    // --with is part of the approved target; only executable argv goes to the runner.
    const ran = await callAgentTool('run_granted_command', { argv: ['/usr/bin/printenv', 'FLY_TOKEN'] }, 'run');
    expect(ran).toContain('exit 0');
    expect(ran).toContain('[FLY_TOKEN]');
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'postAgentActivity' })]));
    expect(JSON.stringify([stored, ran, calls])).not.toContain(secret);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['lower_case', '9TOKEN', 'A'.repeat(65), '../TOKEN'])('rejects the invalid secret name %s without echoing its value', async name => {
  await expect(callAgentTool('store_secret', { name, value: secret }, 'invalid'))
    .rejects.toThrow('store_secret: invalid arguments');
});

it('advertises and permits store_secret beside request_grant on every agent surface, including without a runner', () => {
  for (const dm of [false, true]) for (const corner of [false, true]) for (const runner of [false, true]) {
    expect(agentToolsFor(true, dm, corner, corner, runner).map(tool => tool.name))
      .toEqual(expect.arrayContaining(['store_secret', 'request_grant']));
  }
  expect(agentToolsFor(false, false).map(tool => tool.name)).not.toContain('store_secret');
  expect(isBeelineAgentMcpPermissionRequest({ toolCall: { title: 'mcp.beeline-agent.store_secret' } })).toBe(true);
});
