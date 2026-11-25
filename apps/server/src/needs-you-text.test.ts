import { shortenAsk } from '@beeline/api-contract/phone';
import { describe, expect, it } from 'vitest';
import {
  askSql,
  needsYouRowText,
  needsYouSentence,
  withoutReaderTags,
} from './needs-you.js';
import { PgliteDatabase } from './test-support.js';

describe('the Needs-you ask rule', () => {
  it('picks the asking sentence: the closing question, else the first report sentence', () => {
    expect(needsYouSentence('needs-decision: Build is green. @ada can you ship it?')).toBe(
      '@ada can you ship it?',
    );
    expect(needsYouSentence('The emulator needs a sign-in. Then it runs.')).toBe(
      'The emulator needs a sign-in.',
    );
  });

  it('drops only the reader tag and tidies what it leaves', () => {
    expect(withoutReaderTags('@ada please approve the release check command', 'ada')).toBe(
      'please approve the release check command',
    );
    expect(withoutReaderTags('@ada, can you ask @hoots to rerun it?', 'ada')).toBe(
      'can you ask @hoots to rerun it?',
    );
    expect(withoutReaderTags('Thanks @ada.', 'ada')).toBe('Thanks.');
    expect(withoutReaderTags('@channel please vote?', 'ada')).toBe('please vote?');
    expect(withoutReaderTags('@adam please', 'ada')).toBe('@adam please');
  });

  it('strips hyphenated reader tags while preserving other handles and boundaries', () => {
    expect(needsYouRowText('@a-b can you ask @c-d to review?', 'a-b'))
      .toBe('can you ask @c-d to review?');
    expect(withoutReaderTags('@a-bc please review', 'a-b')).toBe('@a-bc please review');
    expect(withoutReaderTags('Thanks @a-b.', 'a-b')).toBe('Thanks.');
    expect(withoutReaderTags('Thanks @a-b-', 'a-b')).toBe('Thanks -');
    expect(withoutReaderTags('@a.b_c please ask @axb_c?', 'a.b_c'))
      .toBe('please ask @axb_c?');
  });

  it('keeps the start of long asks and strips markdown and long hashes', () => {
    const long = 'Please confirm the App Store review note ' + 'before we ship '.repeat(15);
    expect(shortenAsk(long)).toMatch(/^Please confirm/);
    expect(Array.from(shortenAsk(long)).length).toBeLessThanOrEqual(140);
    expect(needsYouRowText('Turn **Feedback Fixed** notices on or off?\n**Feedback Fixed notices:** off by default. @ada', 'ada'))
      .toBe('Turn Feedback Fixed notices on or off?');
    expect(needsYouRowText('@ada approve commit ' + 'a'.repeat(40), 'ada')).toBe('approve commit aaaaaaa');
    expect(needsYouRowText('needs-decision: Details. **Feedback** off by default. @ada', 'ada', 'Turn Feedback Fixed notices on or off?'))
      .toBe('Turn Feedback Fixed notices on or off?');
  });
});

describe('the ask rule in SQL', () => {
  it('identifies blocks from the stored report status', async () => {
    const database = new PgliteDatabase();
    for (const [card, asks] of [[{reportStatus:'blocked'}, true], [{text:'blocked: text'}, false], [null,false]] as const) {
      const row = (await database.query<{ asks: boolean }>(`SELECT ${askSql('$1::jsonb')} asks`, [JSON.stringify(card)])).rows[0];
      expect(row?.asks).toBe(asks);
    }
  });
});

