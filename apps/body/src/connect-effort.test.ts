import { afterEach, expect, it, vi } from 'vitest';
import { collectConnectWizard, type ConnectModelCatalog, type ConnectPrompts } from './connect-command.js';

vi.mock('@clack/prompts', async original => ({
  ...await original<typeof import('@clack/prompts')>(),
  spinner: () => ({ start() {}, stop() {} }),
}));
afterEach(() => vi.restoreAllMocks());

it.each(['no effort axis', 'failed reread', 'different effort axis', 'new effort axis'])(
  'uses only the chosen pi model effort options: %s', async scenario => {
    const initial: ConnectModelCatalog = {
      currentValue: 'original-model',
      options: [{ id: 'original-model' }, { id: 'chosen-model' }],
      ...(scenario === 'new effort axis' ? {} : { effort: { currentValue: 'high', options: [{ id: 'high' }] } }),
    };
    const loadModels = vi.fn(async (request: { model?: string }) => {
      if (!request.model) return initial;
      if (scenario === 'failed reread') throw new Error('chosen model catalog unavailable');
      return { ...initial, currentValue: 'chosen-model', effort:
        scenario === 'no effort axis' ? undefined : { currentValue: 'low', options: [{ id: 'low' }] } };
    });
    const select = vi.fn(async (request: { message: string; options: Array<{ value: string }> }) =>
      request.message === 'Choose harness' ? 'pi' : request.options[0]!.value);
    const prompts = { select, autocomplete: vi.fn(async () => 'chosen-model'),
      text: vi.fn(), password: vi.fn() } as ConnectPrompts;
    const result = await collectConnectWizard(prompts, loadModels, undefined, { NO_COLOR: '1' }, undefined,
      { detect: () => [], checkProgram: () => {}, announce: () => {} });
    expect(loadModels).toHaveBeenLastCalledWith({ harness: 'pi', model: 'chosen-model' });
    const effortQuestions = select.mock.calls.filter(([request]) => request.message === 'Choose reasoning effort');
    if (scenario === 'no effort axis' || scenario === 'failed reread') {
      expect(effortQuestions).toHaveLength(0);
      expect(result).toEqual({ harness: 'pi', model: 'chosen-model' });
    } else {
      expect(effortQuestions).toHaveLength(1);
      expect(effortQuestions[0]![0].options.map(option => option.value)).toEqual(['low']);
      expect(result).toEqual({ harness: 'pi', model: 'chosen-model', effort: 'low' });
    }
  },
);
