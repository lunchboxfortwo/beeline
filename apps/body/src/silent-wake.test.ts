import { isBackgroundCommand } from '@beeline/api-contract/daemon';
import { expect, it } from 'vitest';
import { nonhumanSilentWake } from './silent-wake.js';

it('accepts join and lifecycle wakes for a silent reply', () => {
  for (const reason of ['joined', 'join_probe', 'subscribed_event', 'watched_corner', 'tagged_lifecycle_retry', 'tagged_lifecycle_restart', 'corner_lifecycle', 'corner_closed'])
    expect(nonhumanSilentWake(reason)).toBe(true);
  expect(isBackgroundCommand('corner_closed')).toBe(true);
  expect(nonhumanSilentWake('human_tag')).toBe(false);
  expect(nonhumanSilentWake('tagged_lifecycle_stop')).toBe(false);
  expect(nonhumanSilentWake('corner_close')).toBe(false);
});
