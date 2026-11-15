import { expect, it } from 'vitest';
import { piRetrySettings } from './pi-retry-settings.js';

it('lets Pi retry a temporary model failure at both layers, twice', () => {
  expect(piRetrySettings()).toEqual({ retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 2 } } });
});
