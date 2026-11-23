import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { syncAgentModelCatalog } from './model-catalog-sync.js';
import type { AgentModelConfigOption } from './model-types.js';

const catalog: AgentModelConfigOption[] = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'gpt-6.2-sol',
    options: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }],
  },
  {
    id: 'reasoning_effort',
    category: 'reasoning_effort',
    currentValue: 'low',
    options: [{ id: 'low' }, { id: 'medium' }],
  },
];

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sync(
  configuration: { model?: string | null; effort?: string | null },
  runtimeSelection?: { model?: string; effort?: string },
) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'model-catalog-sync-'));
  dirs.push(runtimeDir);
  const posted: Array<Record<string, unknown>> = [];
  const probed: Array<{ model?: string; effort?: string } | undefined> = [];
  const api = {
    execute: async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentConfiguration') return configuration;
      posted.push(input);
      return {};
    },
  };
  const result = await syncAgentModelCatalog({
    api: api as never,
    agent: { kind: 'codex', command: 'codex-acp', args: [] },
    agentEnv: {},
    agentId: 'agent',
    workspaceId: 'workspace',
    runtimeDir,
    ...(runtimeSelection ? { runtimeSelection } : {}),
    fetchCatalog: async (_agent, _env, selection) => {
      probed.push(selection);
      return { catalog };
    },
    log: () => {},
  });
  return { result, posted, probed };
}

it('keeps the runtime effort when the owner chose only a model', async () => {
  const { result, posted, probed } = await sync(
    { model: 'gpt-6.2-astra', effort: null },
    { model: 'gpt-6-astra', effort: 'medium' },
  );
  expect(result).toBe('posted');
  expect(probed).toEqual([{ model: 'gpt-6.2-astra', effort: 'medium' }]);
  expect(posted[0]?.selection).toEqual({ model: 'gpt-6.2-astra', effort: 'medium' });
  const options = posted[0]?.options as AgentModelConfigOption[];
  expect(options.map((axis) => axis.currentValue)).toEqual(['gpt-6.2-astra', 'medium']);
});

it('lets each owner-chosen axis outrank the runtime record', async () => {
  const { posted } = await sync(
    { model: null, effort: 'low' },
    { model: 'gpt-6.2-astra', effort: 'medium' },
  );
  expect(posted[0]?.selection).toEqual({ model: 'gpt-6.2-astra', effort: 'low' });
});

it('posts no selection when neither the owner nor the runtime chose one', async () => {
  const { posted } = await sync({ model: null, effort: null });
  expect(posted[0]).not.toHaveProperty('selection');
});
