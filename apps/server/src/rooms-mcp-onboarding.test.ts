import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MUSE_SETUP_RECIPE } from '@beeline/api-contract/phone';
it('publishes the owner-approved Muse instruction on the public connect page', () => {
  expect(readFileSync(new URL('../../site/connect/index.html', import.meta.url), 'utf8')).toContain(MUSE_SETUP_RECIPE);
});
