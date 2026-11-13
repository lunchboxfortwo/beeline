import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
import { headerRevealAfterScroll, NEWEST_MESSAGE_SLOP } from './useTitleBlockVisibility';

it('shows the full header on a small scroll up, keeps it, and hides it at the newest message', () => {
  const away = NEWEST_MESSAGE_SLOP + 400;
  expect(headerRevealAfterScroll(false, away, away + 6)).toBe(true);
  expect(headerRevealAfterScroll(true, away + 6, away - 100)).toBe(true);
  expect(headerRevealAfterScroll(false, away, away - 100)).toBe(false);
  expect(headerRevealAfterScroll(true, away, NEWEST_MESSAGE_SLOP)).toBe(false);
  expect(headerRevealAfterScroll(false, null, away)).toBe(false);
});
