import { deck, hotSurfaces, viewer, agent, chatList, room, listOf, paintedRows, roomWatch, quiet, mountDeck, fixtureScope7 } from './test-support-channels.test-support';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import BuzzChannels from './channels';
import { router } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { resetClientState } from '@/sync/client-reset';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { ChatListHeader } from '@/ui/screens/chats/ChatListHeader';
import { getRoomCornerSummary } from '@/buzz/room-corner-store';
import { type ChatListView, type WorkspaceListView } from '@beeline/buzz-client';

describe('Room deck live path', () => {

  it('filters chats by search and lists message matches below them', async () => {
    deck.chatsResponse = listOf([room('room-a', 20), room('room-b', 10, { unread: true })]);
    const renderer = await mountDeck();
    const header = () => renderer.root.findByType(ChatListHeader);
    await act(async () => header().props.onSearch({ open: true, query: 'room-a', chips: [] }));
    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-a']);
    await act(async () => header().props.onSearch({ open: true, query: '', chips: ['unread'] }));
    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-b']);
    await act(async () => header().props.onSearch({ open: true, query: 'hello', chips: [] }));
    const list = renderer.root.find((node: any) => node.type === 'FlatList');
    let footer!: ReactTestRenderer;
    await act(async () => {
      footer = create(list.props.ListFooterComponent);
    });
    expect(footer.root.findAllByProps({ testID: 'message-search-results' })).not.toHaveLength(0);
    await act(async () => header().props.onSearch({ open: false, query: '', chips: [] }));
    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-a', 'room-b']);
    act(() => {
      footer.unmount();
      renderer.unmount();
    });
  });


  it.each(['unread', 'pinned'] as const)('keeps the %s filter after a Room visit, search close and app remount', async chip => {
    const saved = new Map<string, string>([['@beeline/room-pins/viewer/workspace', JSON.stringify(['room-b'])]]);
    const get = vi.spyOn(AsyncStorage, 'getItem').mockImplementation(async key => saved.get(key) ?? null);
    const set = vi.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => { saved.set(key, value); });
    let renderer: ReactTestRenderer | undefined;
    try {
      deck.chatsResponse = listOf([room('room-a', 20), room('room-b', 10, { unread: true })]);
      renderer = await mountDeck();
      const header = () => renderer!.root.findByType(ChatListHeader);
      await act(async () => header().props.onSearch({ open: true, query: '', chips: [chip] }));
      expect(paintedRows(renderer).map(item => item.room.id)).toEqual(['room-b']);
      await act(async () => deck.blur?.());
      await act(async () => { deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null; });
      expect(header().props.search.chips).toEqual([chip]);
      expect(paintedRows(renderer).map(item => item.room.id)).toEqual(['room-b']);
      await act(async () => header().props.onSearch({ open: false, query: '', chips: [] }));
      expect(paintedRows(renderer).map(item => item.room.id)).toEqual(['room-b']);
      await act(async () => renderer!.unmount());
      await act(async () => { resetClientState(); });
      renderer = await mountDeck();
      expect(header().props.search.chips).toEqual([chip]);
      expect(paintedRows(renderer).map(item => item.room.id)).toEqual(['room-b']);
      await act(async () => header().props.onSearch({ open: true, query: '', chips: [] }));
      expect(paintedRows(renderer).map(item => item.room.id)).toEqual(['room-a', 'room-b']);
    } finally {
      if (renderer) act(() => renderer!.unmount());
      get.mockRestore(); set.mockRestore();
    }
  });

  it('paints a Room delta into the list without a chats read, and ignores drafts', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;
    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('earlier');

    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        roomWatch().emit({
          monolithLive: {
            type: 'draft',
            roomId: 'room-a',
            agentId: 'agent',
            turnId: 'turn',
            text: 'thinking '.repeat(index + 1),
          },
        });
      roomWatch().emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: {
            id: 'm2',
            text: 'the answer',
            createdAt: 20,
            author: agent,
            presentation: 'message',
          },
        },
      });
    });
    await quiet();

    expect(paintedRows(renderer)[0]).toMatchObject({
      unread: true,
      latestMessage: { id: 'm2', text: 'the answer' },
    });
    expect(deck.chatsReads).toBe(readsAtRest);
    await act(async () => renderer.unmount());
  });


  it('reads the list when a corner under a Room changes working or waiting state', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'corner-status' },
      }),
    );
    await quiet();

    expect(deck.chatsReads).toBe(readsAtRest + 1);
    await act(async () => renderer.unmount());
  });


  it('keeps the last known unread dot and corners when the server could not read them', async () => {
    deck.chatsResponse = listOf([
      room('room-a', 10, {
        unread: true,
        cornerCount: 2,
        waitingCornerCount: 1,
        openCorners: [{ id: 'corner-1', name: 'fix', state: 'waiting' }],
      }),
    ]);
    const renderer = await mountDeck();
    expect(paintedRows(renderer)[0]).toMatchObject({ unread: true });
    expect(getRoomCornerSummary('room-a')).toEqual({
      cornerCount: 2,
      openCorners: [{ id: 'corner-1', name: 'fix', state: 'waiting' }],
    });

    deck.chatsResponse = listOf([room('room-a', 10)], { unavailable: ['unread', 'corners'] });
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      }),
    );
    await quiet();

    expect(paintedRows(renderer)[0]).toMatchObject({ unread: true });
    // The corner store keeps the last known summary; a read without it says nothing.
    expect(getRoomCornerSummary('room-a')).toEqual({
      cornerCount: 2,
      openCorners: [{ id: 'corner-1', name: 'fix', state: 'waiting' }],
    });
    await act(async () => renderer.unmount());
  });


  it('keeps its live watch when Rooms only change order', async () => {
    deck.chatsResponse = listOf([room('room-a', 20), room('room-b', 10)]);
    const renderer = await mountDeck();
    const watches = deck.subscriptions.length;

    deck.chatsResponse = listOf([room('room-b', 30), room('room-a', 20)]);
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-b', reason: 'activity' },
      }),
    );
    await quiet();

    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-b', 'room-a']);
    expect(deck.subscriptions).toHaveLength(watches);
    await act(async () => renderer.unmount());
  });


  it('makes the covering read on open even when every cached Room resumes its lane', async () => {
    // Reproduction 4.3: a stored list whose Rooms all resume never read again.
    vi.mocked(mobileSurfaceCache.read).mockImplementation(async (address) =>
      String(address).includes('/workspace/:id/chats')
        ? mobileSurfaceCache.publish(address, chatList({ id: 'cached', text: 'stale', createdAt: 1 }), (_value): _value is ChatListView => true) as never
        : null);
    deck.chatsResponse = chatList({ id: 'm9', text: 'current', createdAt: 50 });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await vi.waitFor(() => expect(() => roomWatch()).not.toThrow());
    await act(async () =>
      roomWatch().emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_700)));
    await quiet();
    expect(deck.chatsReads).toBe(1);
    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('current');
    await act(async () => renderer.unmount());
  });


  it('reads once for the foreground invalidation, and never on a timer', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () => {
      deck.appState = 'background';
      for (const listener of deck.appStateListeners) listener('background');
    });
    await quiet();
    await act(async () => {
      deck.appState = 'active';
      for (const listener of deck.appStateListeners) listener('active');
    });
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest);
    await act(async () =>
      roomWatch().emit({ monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'reconnect' } }),
    );
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);

    await quiet();
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);
    await act(async () => renderer.unmount());
  }, 10_000);


  it('reads nothing while hidden under a Room, then catches up on focus', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () => deck.blur?.());
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      }),
    );
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest);

    await act(async () => {
      deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
    });
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);
    expect(deck.reconnects).toBe(0);
    await act(async () => renderer.unmount());
  });


  it('reads nothing when the deck comes back with nothing it skipped', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;
    await act(async () => deck.blur?.());
    await act(async () => {
      deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
    });
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest);
    await act(async () => renderer.unmount());
  });


  it.each([
    ['a message the socket never announced', 30],
    ['an unannounced message that landed in the same second', 10],
  ])('paints %s from a covering read without replacing the healthy socket', async (_case, createdAt) => {
    deck.chatsResponse = listOf([room('room-a', 10), room('room-b', 10)]);
    const renderer = await mountDeck();
    expect(deck.reconnects).toBe(0);
    const readsAtRest = deck.chatsReads;

    // room-a gets a message the socket never mentions; a change it does
    // announce in room-b is what reads the list next.
    deck.chatsResponse = listOf([
      room('room-a', 10, {
        latestMessage: { id: 'm3', text: 'sent while we were deaf', createdAt, author: agent },
      }),
      room('room-b', 10),
    ]);
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-b', reason: 'phone-write' },
      }),
    );
    await quiet();

    expect(paintedRows(renderer).find((row) => row.room.id === 'room-a')!.latestMessage?.text).toBe(
      'sent while we were deaf',
    );
    expect(deck.reconnects).toBe(0);
    expect(deck.chatsReads).toBe(readsAtRest + 1);
    await act(async () => renderer.unmount());
  });
});


it('R-GITHUB-LANDING: a confirmed nonempty response cannot redirect through a lagging surface snapshot', async () => {
  hotSurfaces.values.clear();
  vi.mocked(mobileSurfaceCache.read).mockResolvedValue(null);
  deck.withholdWorkspaceSnapshot = true;
  try {
    const renderer = await mountDeck();
    expect(router.replace).not.toHaveBeenCalledWith('/beeline/community');
    expect(deck.chatsReads).toBeGreaterThan(0);
    console.log(
      'R-GITHUB-LANDING cold empty-cache navigation trace:',
      JSON.stringify(vi.mocked(router.replace).mock.calls),
    );
    await act(async () => renderer.unmount());
  } finally {
    deck.withholdWorkspaceSnapshot = false;
  }
});
describe('Retained socket deck activation', () => {
const scope7 = fixtureScope7();


  it('catches up skipped Workspace and Room list reads exactly once on activation', async () => {
    const renderer = await scope7.openDeck();
    try {
      await scope7.missChanges();
      expect(paintedRows(renderer)[0]!.latestMessage!.text).toBe('earlier');
      await scope7.activate('active');
      await scope7.advance();
      expect(deck.workspaceReads).toBe(2);
      expect(deck.chatsReads).toBe(2);
      expect(paintedRows(renderer)[0]!.latestMessage!.text).toBe('background reply');
      expect(renderer.root.findByType('BuzzCommunityShell').props.communities[0].name).toBe(
        'Renamed Workspace',
      );
      await scope7.activate('active');
      await scope7.advance(180_000);
      expect(deck.workspaceReads).toBe(2);
      expect(deck.chatsReads).toBe(2);
      expect(deck.reconnects).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });


  it.each([false, true])(
    'preserves a newer Workspace invalidation across an older read: %s',
    async (laterInvalidation) => {
      const renderer = await scope7.openDeck();
      try {
        const oldView: WorkspaceListView = {
          workspaces: [{ id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 }],
          viewer,
          truncated: false,
          watchFilters: [],
        };
        let resolveRead!: (value: WorkspaceListView) => void;
        deck.workspacesResponse = new Promise<WorkspaceListView>((resolve) => {
          resolveRead = resolve;
        });
        const watch = deck.subscriptions.find((entry) =>
          entry.filters.some((filter) => !filter['#h']),
        )!;
        await act(async () =>
          watch.emit({
            monolithLive: {
              type: 'workspace-changed',
              roomId: '',
              workspace: { id: 'workspace', name: 'Work' },
            },
          }),
        );
        await scope7.advance(600);
        expect(deck.workspaceReads).toBe(2);
        await scope7.activate('background');
        deck.workspacesResponse = {
          ...oldView,
          workspaces: [{ ...oldView.workspaces[0]!, name: 'Renamed Workspace', updatedAt: 2 }],
        };
        if (laterInvalidation)
          await act(async () =>
            watch.emit({
              monolithLive: {
                type: 'workspace-changed',
                roomId: '',
                workspace: { id: 'workspace', name: 'Renamed Workspace' },
              },
            }),
          );
        await act(async () => resolveRead(oldView));
        await scope7.advance(180_000);
        expect(deck.workspaceReads).toBe(2);
        expect(renderer.root.findByType('BuzzCommunityShell').props.communities[0].name).toBe(
          'Work',
        );
        await scope7.activate('active');
        await scope7.advance();
        const expectedReads = laterInvalidation ? 3 : 2;
        expect(deck.workspaceReads).toBe(expectedReads);
        expect(renderer.root.findByType('BuzzCommunityShell').props.communities[0].name).toBe(
          laterInvalidation ? 'Renamed Workspace' : 'Work',
        );
        await scope7.activate('active');
        await scope7.advance(180_000);
        expect(deck.workspaceReads).toBe(expectedReads);
        expect(deck.chatsReads).toBe(1);
        expect(deck.reconnects).toBe(0);
      } finally {
        await act(async () => renderer.unmount());
      }
    },
  );


  it('does not read on activation when no incomplete delivery was missed', async () => {
    const renderer = await scope7.openDeck();
    try {
      await scope7.activate('background');
      await scope7.advance(180_000);
      await scope7.activate('active');
      await scope7.advance(180_000);
      expect(deck.workspaceReads).toBe(1);
      expect(deck.chatsReads).toBe(1);
      expect(deck.reconnects).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });


  it('defers catch-up while the deck is covered by a Room', async () => {
    const renderer = await scope7.openDeck();
    try {
      await scope7.missChanges();
      await act(async () => deck.blur?.());
      await scope7.activate('active');
      await scope7.advance();
      expect(deck.workspaceReads).toBe(1);
      expect(deck.chatsReads).toBe(1);
      await act(async () => {
        deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
      });
      await scope7.advance();
      expect(deck.workspaceReads).toBe(2);
      expect(deck.chatsReads).toBe(2);
      expect(deck.reconnects).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });


  it('does not catch up an old identity after a client reset', async () => {
    const renderer = await scope7.openDeck();
    try {
      await scope7.missChanges();
      vi.mocked(loadBuzzIdentity).mockResolvedValue(null);
      await act(async () => resetClientState());
      await scope7.activate('active');
      await scope7.advance(180_000);
      expect(deck.workspaceReads).toBe(1);
      expect(deck.chatsReads).toBe(1);
      expect(deck.reconnects).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
