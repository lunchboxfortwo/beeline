import { it, expect } from 'vitest';
import { scrollFollowOnArrival } from './room-scroll-follow';

it.each([null, 'previous'])('holds an unpinned opening or arrival (%s)', previousNewestId => {
  expect(scrollFollowOnArrival({ previousNewestId, nextNewestId: 'newest', isPinnedToTail: false,
    isUserDragging: false, openLandsOnTail: false })).toBe('hold');
});
