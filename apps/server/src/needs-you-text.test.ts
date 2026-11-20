import { shortenAsk } from '@beeline/api-contract/phone';
import { describe, expect, it } from 'vitest';
import {
  askSql,
  isNeedsYouAsk,
  needsYouRowText,
  needsYouSentence,
  withoutReaderTags,
} from './needs-you.js';
import { PgliteDatabase } from './test-support.js';

describe('the Needs-you ask rule', () => {
  it('holds only blocked and needs-decision reports, never mentions, questions or keywords', () => {
    for (const status of ['blocked', 'needs-decision'])
      expect(isNeedsYouAsk(`${status}: pick an endpoint @ada`)).toBe(true);
    for (const text of [
      'failed: cannot build @ada',
      'done: finished @ada',
      '@ada can you look at this?',
      '@ada please look at this',
      '@ada approve the release',
      '@ada I would love your feedback.',
      'blocked:',
    ])
      expect(isNeedsYouAsk(text)).toBe(false);
  });

  it('picks the asking sentence: the closing question, else the first report sentence', () => {
    expect(needsYouSentence('needs-decision: Build is green. @ada can you ship it?')).toBe(
      '@ada can you ship it?',
    );
    expect(needsYouSentence('blocked: The emulator needs a sign-in. Then it runs.')).toBe(
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
    expect(needsYouRowText('needs-decision: Turn **Feedback Fixed** notices on or off?\n**Feedback Fixed notices:** off by default. @ada', 'ada'))
      .toBe('Turn Feedback Fixed notices on or off?');
    expect(needsYouRowText('@ada approve commit ' + 'a'.repeat(40), 'ada')).toBe('approve commit aaaaaaa');
    expect(needsYouRowText('needs-decision: Details. **Feedback** off by default. @ada', 'ada', 'Turn Feedback Fixed notices on or off?'))
      .toBe('Turn Feedback Fixed notices on or off?');
  });
});

describe('the ask rule in SQL', () => {
  it('reads every message exactly as isNeedsYouAsk does', async () => {
    const database = new PgliteDatabase();
    const samples = [
      'blocked: missing access @ada',
      'needs-decision: choose an endpoint @ada',
      'failed: cannot build @ada',
      'done: finished @ada',
      '@ada can you look?',
      '@ada can you look?  \n',
      '@ada is this ok? I think so.',
      '@ada please look',
      '@ada PLEASE look',
      '@ada Please.',
      'please',
      '@ada I approved it',
      '@ada approve the deploy',
      '@ada approves',
      '@ada feedback welcome',
      '@ada feedbacks',
      '@ada re-approve it',
      '@ada approve_now',
      '@ada approve2',
      '@ada this release train is cursed',
      '@ada ?!',
      '@ada ¿qué? please',
    ];
    for (const text of samples) {
      const row = (
        await database.query<{ asks: boolean }>(`SELECT ${askSql('$1::text')} asks`, [text])
      ).rows[0];
      expect({ text, asks: row?.asks }).toEqual({ text, asks: isNeedsYouAsk(text) });
    }
  });
});

