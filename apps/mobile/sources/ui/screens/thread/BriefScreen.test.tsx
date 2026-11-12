import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ view: null as any, read: vi.fn(), fetch: vi.fn(), open: vi.fn() }));
vi.mock('tamagui', () => ({ ListItem: 'ListItem', Separator: 'Separator', Spinner: 'Spinner', XStack: 'XStack', YStack: 'YStack' }));
vi.mock('@/ui/grammar', () => ({ Copy: 'Copy', Screen: 'Screen', T: 'T' }));
vi.mock('@beeline/buzz-client', () => ({ isRoomView: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'me' }), getEffectiveRelayUrl: async () => 'https://relay.example',
}));
vi.mock('@/buzz/app-error-copy', () => ({ appReadErrorCopy: () => 'Could not read' }));
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string) => ({ relayOrigin, viewerPubkey, endpoint }),
  mobileSurfaceCache: { read: fixture.read, fetch: fixture.fetch },
}));
vi.mock('@/buzz/use-shared-surface', () => ({ useSurfaceSnapshot: (address: unknown) => (address ? fixture.view : null) }));
vi.mock('@/sync/transport/room-view-client', () => ({ RoomViewClient: class {} }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: fixture.open }));
import { BriefScreen } from './BriefScreen';

const texts = (node: any): string[] => node.findAll((child: any) => child.type === 'T' || child.type === 'Copy')
  .map((child: any) => child.props.children).filter((value: unknown) => typeof value === 'string');

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.read.mockReset().mockResolvedValue({});
  fixture.fetch.mockReset();
  fixture.open.mockReset();
});

it('shows the latest brief: revision, spec, the approval quoted exactly, then the files', async () => {
  fixture.view = { cornerBrief: {
    revision: 2,
    spec: '# Reconnect keeps place\nThe transcript keeps its place.\n\n## Done when\n- A reconnect leaves the message where it was.',
    approval: { sourceMessageId: '8f2c41', text: 'Yes, go ahead.', approverName: 'Dan' },
    attachments: [{ title: 'Transcript.tsx', purpose: 'scroll anchor', required: true, url: 'https://example.com/t' }],
  } };
  let tree: any;
  await act(async () => { tree = create(<BriefScreen roomId="corner-1" close={vi.fn()} />); });
  expect(tree.root.findByType('Screen').props.title).toBe('Brief · revision 2');
  const spec = tree.root.find((node: any) => node.props.testID === 'brief-spec');
  expect(texts(spec)).toEqual(['Reconnect keeps place', 'The transcript keeps its place.', 'Done when', '· A reconnect leaves the message where it was.']);
  const approval = tree.root.find((node: any) => node.props.testID === 'brief-approval');
  expect(texts(approval)).toEqual(['Approval', 'Approved by Dan, message 8f2c41:', 'Yes, go ahead.']);
  const file = tree.root.find((node: any) => node.props.testID === 'brief-files').findByType('ListItem');
  act(() => file.props.onPress());
  expect(fixture.open).toHaveBeenCalledWith('https://example.com/t');
  expect(fixture.fetch).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

it('reads a cold brief once when nothing is held, and says when there is none', async () => {
  fixture.read.mockResolvedValue(null);
  fixture.view = { cornerBrief: undefined };
  let tree: any;
  await act(async () => { tree = create(<BriefScreen roomId="corner-1" close={vi.fn()} />); });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(tree.root.findByType('Screen').props.title).toBe('Brief');
  expect(tree.root.findByType('Copy').props.children).toBe('This thread has no brief yet');
  act(() => tree.unmount());
});
