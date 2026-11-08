import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MUSE_SETUP_RECIPE } from '@beeline/api-contract/phone';
it('publishes the owner-approved Muse instruction on both public join surfaces', () => {
  for (const path of ['../assets/mcp/join.html', '../../../web/connect/index.html']) {
    const html = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(html).toContain(MUSE_SETUP_RECIPE);
  }
});
