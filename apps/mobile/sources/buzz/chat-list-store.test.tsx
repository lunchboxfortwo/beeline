import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatListView } from '@beeline/buzz-client';
const store = vi.hoisted(() => ({ value: null as ChatListView | null, changed: () => {} }));
vi.mock('./server-read-owner', () => ({
  liveChatList: () => store.value,
  acquireChatList: () => ({ current: () => store.value,
    subscribe: (listener: () => void) => { store.changed = listener; return () => {}; },
    catchUp: () => {}, release: () => {} }),
}));
import { useChatList } from './chat-list-store';

it('opens with the authorized transcript context once, then paints a changed Workspace name', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  store.value = { workspace: { id: 'work', name: 'Work' }, viewer: {}, chats: [] } as unknown as ChatListView;
  const frames: (string | undefined)[] = [];
  function Header() {
    const view = useChatList({ relayUrl: 'https://local.test', viewerPubkey: 'viewer', workspaceId: 'work' }, { transcriptRoomId: 'room' });
    frames.push(view?.workspace.name);
    return <span>{view?.workspace.name}</span>;
  }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Header />); });
  try {
    expect(frames).toEqual(['Work']);
    act(() => {
      store.value = { ...store.value!, workspace: { ...store.value!.workspace, name: 'Renamed' } };
      store.changed();
    });
    expect(tree.root.findByType('span').props.children).toBe('Renamed');
  } finally { act(() => tree.unmount()); }
});
