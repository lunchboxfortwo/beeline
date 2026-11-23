import { afterEach, expect, it, vi } from 'vitest';
import { collectConnectWizard, type ConnectModelCatalog, type ConnectPrompts } from './connect-command.js';

const spinners = vi.hoisted(() => [] as string[]);
vi.mock('@clack/prompts', async original => ({
  ...await original<typeof import('@clack/prompts')>(),
  spinner: () => ({
    start(message: string) { spinners.push(`start ${message}`); },
    message(message: string) { spinners.push(`message ${message}`); },
    stop() {},
  }),
}));
afterEach(() => vi.restoreAllMocks());

it.each(['no effort axis', 'failed reread', 'different effort axis', 'new effort axis', 'off only'])(
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
        scenario === 'no effort axis' ? undefined : scenario === 'off only' ? { currentValue: 'off', options: [{ id: 'off' }] } : { currentValue: 'low', options: [{ id: 'low' }] } };
    });
    const select = vi.fn(async (request: { message: string; options: Array<{ value: string }> }) =>
      request.message === 'Choose harness' ? 'pi' : request.options[0]!.value);
    const prompts = { select, autocomplete: vi.fn(async () => 'chosen-model'),
      text: vi.fn(), password: vi.fn() } as ConnectPrompts;
    const result = await collectConnectWizard(prompts, loadModels, undefined, { NO_COLOR: '1' }, undefined,
      { detect: () => [], checkProgram: () => {}, announce: () => {} });
    expect(loadModels).toHaveBeenLastCalledWith(expect.objectContaining({ harness: 'pi', model: 'chosen-model' }));
    const effortQuestions = select.mock.calls.filter(([request]) => request.message === 'Choose reasoning effort');
    if (scenario === 'no effort axis' || scenario === 'failed reread' || scenario === 'off only') {
      expect(effortQuestions).toHaveLength(0);
      expect(result).toEqual({ harness: 'pi', model: 'chosen-model' });
    } else {
      expect(effortQuestions).toHaveLength(1);
      expect(effortQuestions[0]![0].options.map(option => option.value)).toEqual(['low']);
      expect(result).toEqual({ harness: 'pi', model: 'chosen-model', effort: 'low' });
    }
  },
);

it('covers the provider key check and the final model read with spinners', async () => {
  spinners.length = 0;
  const loadModels = vi.fn(async (request: { apiKey?: string }) => request.apiKey
    ? { currentValue: 'm', options: [{ id: 'm' }] }
    : { currentValue: 'm', options: [{ id: 'm' }], note: 'nothing enumerated' });
  const select = vi.fn(async (request: { message: string; options: Array<{ value: string }> }) =>
    request.message === 'Choose harness' ? 'pi' : request.options[0]!.value);
  const prompts = { select, autocomplete: vi.fn(async () => 'm'), text: vi.fn(),
    password: vi.fn(async () => 'sk-or-new') } as ConnectPrompts;
  const verifyKey = vi.fn(async (_input: unknown, step?: { say: (line: string) => void }) => {
    step?.say('waiting for openrouter.ai to verify the OpenRouter key (GET /api/v1/key)');
  });
  const result = await collectConnectWizard(prompts, loadModels,
    { read: async () => undefined, save: async () => undefined }, { NO_COLOR: '1' }, verifyKey,
    { detect: () => [], checkProgram: () => {}, announce: () => {} });
  expect(result).toEqual({ harness: 'pi', provider: 'openrouter', apiKey: 'sk-or-new', model: 'm' });
  expect(spinners).toEqual([
    'start Checking Pi…',
    'start Checking the OpenRouter key…',
    'message waiting for openrouter.ai to verify the OpenRouter key (GET /api/v1/key)',
    'start Reading Pi models…',
  ]);
});
