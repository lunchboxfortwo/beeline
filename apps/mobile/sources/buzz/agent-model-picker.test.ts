import { expect, it } from 'vitest';
import { effortConfigAxis } from './agent-model-picker';

it.each([{ levels: [] }, { levels: ['off'] }, { levels: ['off', 'low'] }])('offers effort only when the selected catalog has thinking choices: %j', ({ levels }) => {
  const axis = { id: 'thought_level', category: 'thought_level', options: levels.map(id => ({ id })) };
  expect(effortConfigAxis([axis])).toEqual(levels.includes('low') ? axis : undefined);
});
