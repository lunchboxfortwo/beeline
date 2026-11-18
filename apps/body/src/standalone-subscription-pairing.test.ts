import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { checkAdapterSession } from './adapter-session-check.js';
import { AgentSignIn, answerAgentSignInFrame } from './agent-sign-in.js';
import { completeDevicePairing } from './device-pairing.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import {
  CODEX_DEVICE_OUTPUT,
  GROK_DEVICE_OUTPUT,
} from '../../../packages/test-helpers/helpers/helper.js';

vi.mock('./cliproxy.js', async (original) => ({
  ...(await original<typeof import('./cliproxy.js')>()),
  machineCliProxy: async () => undefined,
}));
vi.mock('./runtime.js', async (original) => ({
  ...(await original<typeof import('./runtime.js')>()),
  stageMonolithAgentRuntime: async () => ({ configPath: 'staged-config', runtime: {} }),
}));
vi.mock('./daemon-api-client.js', async (original) => ({
  ...(await original<typeof import('./daemon-api-client.js')>()),
  activateDaemonTransport: async () => ({ runtime: {} }),
}));
vi.mock('./acp.js', async (original) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await original<typeof import('./acp.js')>()),
    AcpClient: class extends EventEmitter {
      constructor(
        private readonly options: { agentCommand: string; agentEnv: Record<string, string> },
      ) {
        super();
      }
      async startProcess() {
        const env = this.options.agentEnv;
        const grok = this.options.agentCommand === 'grok';
        const dir = grok
          ? (env.GROK_HOME ?? join(env.HOME!, '.grok'))
          : (env.CODEX_HOME ?? join(env.HOME!, '.codex'));
        const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
        expect(grok ? Object.values(auth)[0] : auth.tokens).toMatchObject(
          grok ? { key: 'native-access' } : { access_token: 'native-access' },
        );
        this.emit('initialized', { protocolVersion: 1, agentCapabilities: {} });
      }
      async stopProcess() {}
      async sessionNew() {
        return {
          sessionId: 'native',
          raw: {
            configOptions: [
              {
                id: 'model',
                category: 'model',
                options: [{ id: this.options.agentCommand === 'grok' ? 'grok-4' : 'gpt-5' }],
              },
            ],
          },
        };
      }
      async setConfigOption() {
        return {};
      }
    },
  };
});

it.each(['codex', 'grok'] as const)(
  'standalone subscription-only %s pairing reaches the helper login card',
  async (harness) => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-standalone-pairing-'));
    const dir = join(home, harness === 'grok' ? '.grok' : '.codex');
    try {
      await mkdir(dir);
      await writeFile(
        join(dir, 'auth.json'),
        JSON.stringify(
          harness === 'grok'
            ? {
                'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
                  key: 'native-access',
                  auth_mode: 'oidc',
                },
              }
            : {
                auth_mode: 'chatgpt',
                tokens: { access_token: 'native-access', refresh_token: 'native-refresh' },
              },
        ),
      );
      if (harness === 'codex')
        await expect(
          checkAdapterSession({
            command: harness,
            agentKind: harness,
            env: { HOME: home },
            scratchRoot: home,
          }),
        ).resolves.toMatchObject({ sessionStart: 'created' });
      const catalog = await fetchAgentModelCatalog(
        { kind: harness, command: harness, args: [] },
        { HOME: home },
      );
      expect(catalog.catalog[0]!.options).toEqual([
        { id: harness === 'grok' ? 'grok-4' : 'gpt-5' },
      ]);
      const launch = vi.fn(async () => 123);
      await expect(
        completeDevicePairing(
          {
            agentSecretKey: '1'.repeat(64),
            bodySecretKey: '2'.repeat(64),
            agentName: 'standalone',
            harness,
            model: harness === 'grok' ? 'grok-4' : 'gpt-5',
            soul: '',
            workspaceId: 'workspace',
            workspaceName: 'Workspace',
            pairedBy: 'owner',
            monolithBaseUrl: 'https://example.test',
            daemonExchangeToken: 'exchange',
          },
          {
            selectedAgent: { kind: harness, command: harness, args: [] },
            localConfig: { agentBinary: harness, mcpBinary: 'mcp', agentEnv: { HOME: home } },
            fetchImpl: vi.fn(async () => Response.json({})),
            launch,
          },
        ),
      ).resolves.toMatchObject({ pid: 123 });
      expect(launch).toHaveBeenCalledOnce();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      const signIn = new AgentSignIn({
        harness,
        operatorHome: home,
        agentEnv: {},
        onResult: vi.fn(),
        proxy: async () => ({
          saveLogin: vi.fn(),
          login: (flag) => ({ command: 'proxy', args: [flag], env: {} }),
        }),
        spawn: (() => {
          queueMicrotask(() =>
            child.stdout.write(harness === 'grok' ? GROK_DEVICE_OUTPUT : CODEX_DEVICE_OUTPUT),
          );
          return child;
        }) as never,
      });
      const execute = vi.fn(async () => undefined);
      await answerAgentSignInFrame(
        { execute },
        'agent',
        signIn,
        { type: 'agent-sign-in', step: 'start', attemptId: 'attempt', cardId: 'card' },
        new Map(),
      );
      expect(execute).toHaveBeenCalledWith(
        'reportAgentSignIn',
        expect.objectContaining({
          kind: 'device-code',
          userCode: harness === 'grok' ? 'DC7F-7GCV' : 'O55M-GK99G',
        }),
      );
      signIn.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
