import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', Image: 'Image', ScrollView: 'ScrollView',
  Platform: { OS: 'web' }, NativeModules: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class extends Error {},
  monolithSession: { authorization: async () => 'fixture-access' },
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://fixture.invalid' }) }));
vi.mock('@/buzz/room-corner-store', () => ({
  acceptCornerStatusFrame: vi.fn(), noteCornerLaneReleased: vi.fn(),
  noteCornerLaneSubscribed: vi.fn(), noteCornerSocketDropped: vi.fn(), noteRoomCornersChanged: vi.fn(),
}));
vi.mock('@/buzz/artifact-link', () => ({
  artifactImageSource: media.source, releaseArtifactImageSource: vi.fn(),
  subscribeArtifactBytesPurge: () => () => {}, fetchArtifactText: vi.fn(),
}));
vi.mock('./IndexRow', () => ({ IndexRow: 'IndexRow' }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-reanimated', () => ({ default: { View: 'AnimatedView' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { ArtifactImage } from './ArtifactMedia';
import { reconnectNow, resetSharedLiveConnection, sharedLiveConnection, useConnectionFailure } from '@/sync/transport/live-connection';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  requests: { id: string; op: string }[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { Socket.instances.push(this); }
  send(frame: string) { const value = JSON.parse(frame); if (value.t === 'req') this.requests.push(value); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.close(); this.onclose?.(); }
  reply(index: number, result: unknown) { this.onmessage?.({ data: JSON.stringify({ t: 'res', id: this.requests[index].id, ok: true, result }) }); }
}
const attachment = { url: '/v1/media/11111111-1111-4111-8111-111111111111', name: 'image.png', mimeType: 'image/png', size: 3 };
let tree: any;
function BannerProbe() { return React.createElement('Banner', { failed: useConnectionFailure() }); }
async function render() {
  await act(async () => { tree = create(<><BannerProbe /><ArtifactImage attachment={attachment} fit="cover" testID="image" /></>); });
}
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); Socket.instances = []; media.source.mockReset();
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount()); tree = undefined;
  resetSharedLiveConnection(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it('a failed image adds no local error and rereads after confirmed recovery on an already open socket', async () => {
  const connection = sharedLiveConnection();
  const failed = connection.request('reactToMessage', { roomId: 'a', messageId: 'm', emoji: '👍' }).catch(error => error);
  await flush(); const first = Socket.instances[0]; first.open(); first.drop(); await failed;
  await flush(); Socket.instances[1].drop(); await flush();
  connection.reconnectNow(); await flush(); const socket = Socket.instances[2]; socket.open();
  media.source.mockRejectedValueOnce(new Error('image read failed')).mockResolvedValue({ uri: 'file:///image.png' });
  await render();
  expect(tree.root.findByType('Banner').props.failed).toBe(true);
  expect(tree.root.findAllByProps({ testID: 'artifact-image-failed' })).toHaveLength(0);
  await act(async () => reconnectNow());
  expect(media.source).toHaveBeenCalledTimes(1);
  await act(async () => socket.reply(0, { workspaces: [] }));
  expect(tree.root.findByType('Banner').props.failed).toBe(false);
  expect(media.source).toHaveBeenCalledTimes(2);
  expect(tree.root.findByType('Image').props.source).toEqual({ uri: 'file:///image.png' });
  expect(Socket.instances).toHaveLength(3);
});

it('a failed socket image read reads again on the replacement connection', async () => {
  const connection = sharedLiveConnection();
  media.source.mockImplementation(async () => {
    await connection.request('readMediaMetadata', { objectId: '11111111-1111-4111-8111-111111111111' });
    return { uri: 'file:///image.png' };
  });
  await render(); await flush();
  const first = Socket.instances[0]; await act(async () => first.open());
  await act(async () => first.drop());
  expect(tree.root.findByType('Banner').props.failed).toBe(false);
  expect(tree.root.findAllByProps({ testID: 'artifact-image-failed' })).toHaveLength(0);
  await flush();
  const next = Socket.instances[1]; await act(async () => next.open());
  expect(next.requests[0].op).toBe('readWorkspaces');
  await act(async () => next.reply(0, { workspaces: [] }));
  // Read the current metadata request; recovery cancels the preceding effect.
  await act(async () => {
    for (let i = 1; i < next.requests.length; i++) next.reply(i, {});
  });
  expect(tree.root.findByType('Banner').props.failed).toBe(false);
  expect(tree.root.findByType('Image').props.source.uri).toBe('file:///image.png');
  expect(Socket.instances).toHaveLength(2);
});
