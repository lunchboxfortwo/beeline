import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  loaded: 0,
  capture: vi.fn(),
  screen: vi.fn(),
  tracked: vi.fn(),
}));
vi.mock('./analytics-key', () => ({ postHogKey: 'web-key' }));
vi.mock('./tracking', () => {
  posthog.loaded++;
  return {
    tracking: { key: 'web-key', capture: posthog.capture, screen: posthog.screen },
    useNavigationTracker: (_options: unknown, _ref: unknown, client: unknown) =>
      posthog.tracked(client),
  };
});

import { TrackingRoot } from './TrackingRoot.web';
import { tracking } from './analytics.web';

it('loads PostHog after the first screen draws and delivers events captured before then', async () => {
  tracking!.capture('ota_update_available', { ota_version: null });
  tracking!.screen('beeline/channels');
  let root!: { update(element: React.ReactElement): void; toJSON(): unknown };
  await act(async () => {
    root = create(<TrackingRoot drawn={false}>{'app'}</TrackingRoot>);
  });
  expect(posthog.loaded).toBe(0);
  expect(posthog.capture).not.toHaveBeenCalled();
  await act(async () => {
    root.update(<TrackingRoot drawn>{'app'}</TrackingRoot>);
  });
  expect(posthog.loaded).toBe(1);
  expect(posthog.capture).toHaveBeenCalledWith('ota_update_available', { ota_version: null });
  expect(posthog.screen).toHaveBeenCalledWith('beeline/channels');
  expect(posthog.tracked).toHaveBeenCalledWith(expect.objectContaining({ key: 'web-key' }));
  expect(root.toJSON()).toBe('app');
});
