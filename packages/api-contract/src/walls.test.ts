import { expect, it } from 'vitest';
import { wall, WallRefusal, WALL_KINDS } from './walls.js';

it('names the five walls and preserves the original refusal through propagation', () => {
  expect(WALL_KINDS).toEqual(['signed-in', 'membership', 'credentials', 'sandbox', 'stop']);
  const refusal = wall('credentials', 'another agent owns this credential');
  expect(refusal).toBeInstanceOf(WallRefusal);
  expect(wall('membership', refusal)).toBe(refusal);
  expect(refusal.status).toBe(403);
});

it('preserves an operational outage rather than converting it into access denied', () => {
  const outage = new Error('database unavailable');
  expect(wall('membership', outage)).toMatchObject({ message: 'database unavailable', status: 503, cause: outage });
  expect(wall('membership', Object.assign(new Error('expired account'), { status: 401 })).status).toBe(401);
});
