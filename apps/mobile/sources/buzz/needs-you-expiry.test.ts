import { expect, it } from 'vitest';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import { nextExpiry, stillOwed } from './needs-you-expiry';

const item = (messageId: string, expiresAt?: number) => ({ messageId, ...(expiresAt === undefined ? {} : { expiresAt }) }) as NeedsYouItemView;

it('an item past its expiry is no longer counted, and the next expiry is the soonest one still owed', () => {
  const items = [item('old', 100), item('soon', 200), item('later', 300), item('never')];
  expect(stillOwed(items, 150_000).map((entry) => entry.messageId)).toEqual(['soon', 'later', 'never']);
  expect(nextExpiry(items, 150_000)).toBe(200_000);
  expect(stillOwed(items, 400_000).map((entry) => entry.messageId)).toEqual(['never']);
  expect(nextExpiry(items, 400_000)).toBeNull();
});
