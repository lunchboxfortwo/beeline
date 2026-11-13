import { expect, it, vi } from 'vitest';
import { fetchAgentModelCatalog, validateAgentModelSelection } from './model-catalog.js';

vi.mock('./agent-process.js', () => ({
  startAgentProcess: vi.fn(),
  stopAgentProcess: vi.fn(async () => {}),
}));

const axes = (model: string) => [
  {
    id: 'model', category: 'model', currentValue: model,
    options: [{ id: 'custom/plain' }, { id: 'custom/reasoning' }],
  },
  {
    id: 'thought_level', category: 'thought_level', currentValue: 'off',
    options: (model === 'custom/plain' ? ['off'] : ['off', 'low']).map(id => ({ id })),
  },
];
const setConfigOption = vi.fn(async (_session: string, axis: string, value: string) => {
  if (axis === 'model') return { configOptions: axes(value) };
  return {};
});
vi.mock('./acp.js', () => ({
  AcpClient: class {
    async sessionNew() {
      return { sessionId: 'session', raw: { configOptions: axes('custom/reasoning') } };
    }
    setConfigOption = setConfigOption;
  },
}));

it.each(['custom/plain', 'custom/reasoning'])(
  'publishes the selected custom model own ladder: %s', async model => {
    const agent = { kind: 'pi' as const, command: 'pi-acp', args: [] };
    const { catalog, raw } = await fetchAgentModelCatalog(agent, {}, { model });
    expect(catalog.find(axis => axis.category === 'model')?.currentValue).toBe(model);
    expect(catalog.find(axis => axis.category === 'model')?.options).toContainEqual({ id: model });
    const efforts = catalog.find(axis => axis.category === 'thought_level')!.options;
    expect(efforts.map(option => option.id)).toEqual(model === 'custom/plain' ? ['off'] : ['off', 'low']);
    expect(raw.find(axis => axis.category === 'model')?.currentValue).toBe(model);
    for (const effort of efforts) {
      await expect(validateAgentModelSelection(agent, {}, { model, effort: effort.id })).resolves.toBeDefined();
    }
  },
);
