import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { fetchAgentModelCatalog, validateAgentModelSelection } from './model-catalog.js';

const launches = vi.hoisted(() => [] as Record<string, string>[]);
const probe = vi.hoisted(() => ({
  raw: {} as Record<string, unknown>,
  check: async (_env: Record<string, string>) => {},
}));
beforeEach(() => {
  probe.raw = {};
  probe.check = async () => {};
});
vi.mock('./cliproxy.js', async (original) => ({
  ...(await original<typeof import('./cliproxy.js')>()),
  machineCliProxy: async () => ({
    endpoint: { url: 'http://127.0.0.1:41234', key: 'local-inference-key' },
  }),
}));
vi.mock('./acp.js', async (original) => ({
  ...(await original<typeof import('./acp.js')>()),
  AcpClient: class {
    constructor(private readonly options: { agentEnv: Record<string, string> }) {
      launches.push(options.agentEnv);
    }
    async startProcess() {
      await probe.check(this.options.agentEnv);
    }
    async stopProcess() {}
    async sessionNew() {
      return { sessionId: 'probe', raw: probe.raw };
    }
    async setConfigOption() {
      return probe.raw;
    }
  },
}));

it.each([
  ['ANTHROPIC', 'store'],
  ['OPENAI', 'store'],
  ['ANTHROPIC', 'env'],
  ['OPENAI', 'env'],
] as const)(
  'keeps the operator %s key from %s native during catalog probes',
  async (provider, source) => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-goose-catalog-'));
    const key = `${provider}_API_KEY`;
    try {
      await mkdir(join(home, '.config/goose'), { recursive: true });
      await writeFile(
        join(home, '.config/goose/secrets.yaml'),
        source === 'store' ? `${key}: operator-key\n` : '',
      );
      await writeFile(
        join(home, '.config/goose/config.yaml'),
        `GOOSE_PROVIDER: ${provider.toLowerCase()}\n`,
      );
      probe.check = async (env) => {
        expect(
          parse(await readFile(join(env.GOOSE_PATH_ROOT!, 'config/config.yaml'), 'utf8')),
        ).toEqual({ GOOSE_PROVIDER: provider.toLowerCase() });
        expect(await readFile(join(env.GOOSE_PATH_ROOT!, 'config/secrets.yaml'), 'utf8')).toBe(
          source === 'store' ? `${key}: operator-key\n` : '',
        );
      };
      await expect(
        fetchAgentModelCatalog(
          { kind: 'goose', command: 'goose', args: [] },
          {
            HOME: home,
            GOOSE_PROVIDER: provider.toLowerCase(),
            ...(source === 'env' ? { [key]: 'operator-key' } : {}),
          },
        ),
      ).resolves.toEqual({ raw: [], catalog: [] });
      const env = launches.at(-1)!;
      expect(env[key]).toBe(source === 'env' ? 'operator-key' : undefined);
      expect(env).not.toHaveProperty(`${provider}_HOST`);
      const other = provider === 'ANTHROPIC' ? 'OPENAI' : 'ANTHROPIC';
      expect(env[`${other}_API_KEY`]).toBe('local-inference-key');
      expect(env[`${other}_HOST`]).toBe('http://127.0.0.1:41234');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(['fetch', 'validate'] as const)(
  '%s uses private Pi proxy providers and retains advertised choices',
  async (action) => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-pi-catalog-'));
    const choices = [{ id: 'anthropic/claude-sonnet-4-6' }, { id: 'openai-codex/gpt-5.4' }];
    probe.raw = { configOptions: [{ id: 'model', category: 'model', options: choices }] };
    probe.check = async (env) => {
      expect(env.HOME).not.toBe(home);
      const models = JSON.parse(
        await readFile(join(env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'),
      );
      expect(models.providers.anthropic).toMatchObject({
        baseUrl: 'http://127.0.0.1:41234',
        apiKey: 'local-inference-key',
      });
      expect(models.providers['openai-codex']).toMatchObject({
        baseUrl: 'http://127.0.0.1:41234/v1',
        apiKey: 'local-inference-key',
      });
      expect(models.providers['openai-codex'].models).toContainEqual(
        expect.objectContaining({ id: 'gpt-5.4', api: 'openai-responses' }),
      );
    };
    try {
      const agent = { kind: 'pi' as const, command: 'pi-acp', args: [] };
      const result =
        action === 'fetch'
          ? await fetchAgentModelCatalog(agent, { HOME: home })
          : await validateAgentModelSelection(agent, { HOME: home }, { model: choices[0]!.id });
      expect(result.catalog[0]!.options.map((choice) => choice.id).sort()).toEqual(
        choices.map((choice) => choice.id).sort(),
      );
      await expect(
        readFile(join(launches.at(-1)!.PI_CODING_AGENT_DIR!, 'models.json')),
      ).rejects.toThrow();
      await expect(readlink(launches.at(-1)!.TMPDIR!)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(['fetch', 'validate'] as const)(
  '%s preserves OpenCode static keys in its private store',
  async (action) => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-opencode-catalog-'));
    const model = 'anthropic/claude-sonnet-4-6';
    probe.raw = { configOptions: [{ id: 'model', category: 'model', options: [{ id: model }] }] };
    probe.check = async (env) => {
      expect(env.HOME).not.toBe(home);
      expect(
        JSON.parse(await readFile(join(env.XDG_DATA_HOME!, 'opencode/auth.json'), 'utf8')),
      ).toEqual({ anthropic: { type: 'api', key: 'operator-key' } });
      const routes = JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider;
      expect(routes).not.toHaveProperty('anthropic');
      expect(routes.openai.options).toEqual({
        baseURL: 'http://127.0.0.1:41234/v1',
        apiKey: 'local-inference-key',
      });
    };
    try {
      await mkdir(join(home, '.local/share/opencode'), { recursive: true });
      await writeFile(
        join(home, '.local/share/opencode/auth.json'),
        JSON.stringify({
          anthropic: { type: 'api', key: 'operator-key' },
          openai: { type: 'oauth', refresh: 'native-refresh' },
        }),
      );
      const agent = { kind: 'opencode' as const, command: 'opencode', args: [] };
      const result =
        action === 'fetch'
          ? await fetchAgentModelCatalog(agent, { HOME: home })
          : await validateAgentModelSelection(agent, { HOME: home }, { model });
      expect(result.catalog[0]!.options).toEqual([{ id: model }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
