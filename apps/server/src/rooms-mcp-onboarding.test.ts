import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MUSE_SETUP_RECIPE } from '@beeline/api-contract/phone';
it('publishes the exact owner-approved Muse runtime recipe on both public join surfaces', () => {
  for (const path of ['../assets/mcp/join.html', '../../../web/connect/index.html']) {
    const html = readFileSync(new URL(path, import.meta.url), 'utf8');
    const encoded = html.match(/id="muse-setup-recipe">([\s\S]*?)<\/pre>/)![1]!;
    const text = encoded
      .replaceAll('&#x27;', "'")
      .replaceAll('&quot;', '"')
      .replaceAll('&gt;', '>')
      .replaceAll('&lt;', '<')
      .replaceAll('&amp;', '&');
    expect(text).toBe(MUSE_SETUP_RECIPE);
    expect(html).toContain('Claude.ai in a browser cannot be woken there');
  }
});
