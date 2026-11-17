import type { NeedsYouItemView } from '@beeline/api-contract/phone';

/** The server stops counting an item at its expiry and sends no delta for it. */
export function stillOwed(items: readonly NeedsYouItemView[], now: number): NeedsYouItemView[] {
  return items.filter((item) => item.expiresAt === undefined || item.expiresAt * 1000 > now);
}

/** When the soonest owed item expires, in milliseconds, or null when none will. */
export function nextExpiry(items: readonly NeedsYouItemView[], now: number): number | null {
  const times = stillOwed(items, now).flatMap((item) => (item.expiresAt === undefined ? [] : [item.expiresAt * 1000]));
  return times.length ? Math.min(...times) : null;
}
