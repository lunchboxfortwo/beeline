import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  platform: 'ios', viewer: 'viewer-a' as string | null, origin: 'https://server.test',
  pathname: '/', params: {} as Record<string, string>, response: null as unknown,
  store: new Map<string, string>(),
}));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.platform; } } }));
vi.mock('expo-router', () => ({ usePathname: () => state.pathname, useGlobalSearchParams: () => state.params }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzViewerPubkey: async () => state.viewer }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: state.origin }) }));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => null }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  getString(key: string) { return state.store.get(key); }
  set(key: string, value: string) { state.store.set(key, value); }
  delete(key: string) { state.store.delete(key); }
} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => null, setItem: async () => {},
} }));
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default', getLastNotificationResponseAsync: async () => state.response,
}));

import { durablePage, restoreLastPage } from './last-page';
import { finishRestoredRoom, observeRestoredPage } from './restored-page';
import { useRememberLastPage } from './use-remember-last-page';
import { redirectSystemPath } from '@/app/+native-intent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function NavigationObserver() { useRememberLastPage(); return null; }
async function visit(pathname: string, params: Record<string, string> = {}) {
  state.pathname = pathname; state.params = params;
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<NavigationObserver />); });
  await act(async () => tree.unmount());
}
beforeEach(() => {
  state.platform = 'ios'; state.viewer = 'viewer-a'; state.origin = 'https://server.test';
  state.pathname = '/'; state.params = {}; state.response = null; state.store.clear();
  observeRestoredPage('/');
});

it.each(['ios', 'android'])('writes committed navigation and restores a cold %s launch before screens mount', async platform => {
  state.platform = platform;
  await visit('/beeline/chat/corner-a', { channelId: 'corner-a', communityId: 'workspace-a', parent: 'room-a',
    notificationMessageId: 'old-message', notificationResponseId: 'old-tap' });
  expect([...state.store.values()]).toEqual(['/beeline/chat/corner-a?communityId=workspace-a&parent=room-a']);
  expect(await redirectSystemPath({ path: '/', initial: true })).toBe('/beeline/chat/corner-a?communityId=workspace-a&parent=room-a');
  expect(await redirectSystemPath({ path: '/', initial: false })).toBe('/');
});

it('lets notification taps and explicit deep links outrank the saved page', async () => {
  await visit('/beeline/chat/saved');
  state.response = { actionIdentifier: 'default', notification: { request: { identifier: 'tap', content: { data: {
    type: 'channel-activity', target: 'message', channelId: 'pushed', workspaceId: 'workspace', roomId: 'pushed',
    messageId: 'a'.repeat(64),
  } } } } };
  const pushed = await redirectSystemPath({ path: '/', initial: true });
  expect(pushed).toContain('/beeline/chat/pushed?');
  expect(pushed).toContain('notificationMessageId=');
  expect(finishRestoredRoom('saved', false)).toBe(false);
  const link = 'beeline://beeline/chat/linked?communityId=w';
  expect(await redirectSystemPath({ path: link, initial: true })).toBe(link);
});

it('keeps the preceding page through transient routes and drops action parameters', async () => {
  await visit('/beeline/settings');
  for (const path of ['/beeline/onboarding', '/beeline/community', '/review/secret', '/join/token', '/text-selection',
    '/artifact-viewer', '/beeline/settings/workbench/connect-signin', '/beeline/settings/workbench/wallet-send']) {
    await visit(path);
    expect(await restoreLastPage('/')).toBe('/beeline/settings');
  }
  expect(durablePage('/beeline/channels', { communityId: 'w', newRoom: '1' })).toBe('/beeline/channels?communityId=w');
  expect(durablePage('/beeline/settings/schedule', { roomId: 'r' })).toBeNull();
  expect(durablePage('/beeline/human-profile', { memberId: 'person', workspaceId: 'w' })).toBe('/beeline/human-profile?memberId=person&workspaceId=w');
});

it('falls back once for a missing or closed restored Room and forgets it', async () => {
  for (const room of ['deleted', 'closed']) {
    await visit(`/beeline/chat/${room}`);
    await restoreLastPage('/');
    expect(finishRestoredRoom('another-room', false)).toBe(false);
    expect(finishRestoredRoom(room, false)).toBe(true);
    expect(await restoreLastPage('/')).toBe('/');
    expect(finishRestoredRoom(room, false)).toBe(false);
  }
});

it('does not fall back after a successful read or navigation away from the restored page', async () => {
  await visit('/beeline/chat/live'); await restoreLastPage('/');
  expect(finishRestoredRoom('live', true)).toBe(false);
  expect(finishRestoredRoom('live', false)).toBe(false);
  await restoreLastPage('/'); await visit('/beeline/tray');
  expect(finishRestoredRoom('live', false)).toBe(false);
});

it('keeps accounts and servers separate, and leaves signed-out and web launches unchanged', async () => {
  await visit('/beeline/chat/private');
  state.viewer = 'viewer-b'; expect(await restoreLastPage('/')).toBe('/');
  state.viewer = 'viewer-a'; state.origin = 'https://other.test'; expect(await restoreLastPage('/')).toBe('/');
  state.origin = 'https://server.test'; state.viewer = null; expect(await restoreLastPage('/')).toBe('/');
  state.viewer = 'viewer-a'; state.platform = 'web';
  await visit('/beeline/settings');
  expect(await restoreLastPage('/')).toBe('/');
  expect([...state.store.values()]).toEqual(['/beeline/chat/private']);
});

it('ignores malformed and retired stored pages', async () => {
  await visit('/beeline/chat/saved');
  const key = [...state.store.keys()][0]!;
  for (const invalid of ['garbage', '//elsewhere.test', '/retired-route', '/beeline/onboarding', '/beeline/chat/%', '/beeline/workflow-run']) {
    state.store.set(key, invalid);
    expect(await restoreLastPage('/')).toBe('/');
  }
});
