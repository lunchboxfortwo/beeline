import { expect, it } from 'vitest';
import { headContainsCurrentMain } from './github-operations-read-pr-checks-status.js';

it('does not treat a head that already contains current main as a merge conflict', () => {
  const main = 'a'.repeat(40);
  expect(headContainsCurrentMain('dirty', main, main)).toBe(true);
  expect(headContainsCurrentMain('dirty', 'b'.repeat(40), main)).toBe(false);
  expect(headContainsCurrentMain('dirty', undefined, main)).toBe(false);
  expect(headContainsCurrentMain('clean', main, main)).toBe(false);
});
