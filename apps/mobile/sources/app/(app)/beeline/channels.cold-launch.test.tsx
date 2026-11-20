import {
  transitions,
  deck,
  hotSurfaces,
  chatList,
  paintedRows,
  quiet,
  fixtureScope1,
} from './test-support-channels.test-support';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SurfaceResponseCache, isWorkspaceListView, type ChatListView } from '@beeline/buzz-client';
import { SurfaceRegistry } from '@/buzz/surface-registry';
import BuzzChannels from './channels';
import { router } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadPendingInvite } from '@/buzz/pending-invite';
import {
  markInitialLandingResolved,
  suppressInitialLandingNavigation,
} from '@/navigation/initial-landing';
import Index from '../index';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';

describe('Saved deck cold launch', () => {
  const scope1 = fixtureScope1();

  it('opens a fresh deck while native interactions hold Workspace persistence', async () => {
    // F02: fresh sign-in has no selected Workspace. Completed reads must
    // produce usable chats without Activity recreation or disk completion.
    scope1.saveDeck();
    deck.workspacesResponse = [...hotSurfaces.saved.values()].find(isWorkspaceListView)!;
    deck.chatsResponse = [...hotSurfaces.saved.values()].find(
      (value) => !isWorkspaceListView(value),
    );
    hotSurfaces.saved.clear();
    deck.selectedWorkspace = null;
    const writes: Array<() => Promise<void>> = [];
    const registry = new SurfaceRegistry(
      new SurfaceResponseCache({
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
      }),
      (value) => value,
      (_address, value) => value,
      (_key, work) =>
        new Promise((resolve) => {
          writes.push(async () => {
            await work();
            resolve();
          });
        }),
    );
    // Keep the existing renderer fixture's subscriptions, but execute the
    // real fetch/persistence boundary instead of its immediate-write fake.
    registry.observe('/workspaces', (address, value) => {
      const fixtureAddress = JSON.stringify([
        address.relayOrigin,
        address.viewerPubkey,
        address.endpoint,
        address.params,
      ]);
      mobileSurfaceCache.publish(fixtureAddress as never, value, isWorkspaceListView);
    });
    const fetch = vi
      .spyOn(mobileSurfaceCache, 'fetch')
      .mockImplementation(async (address, guard, request) => {
        const [relayOrigin, viewerPubkey, endpoint, params] = JSON.parse(
          address as unknown as string,
        );
        return registry.fetch({ relayOrigin, viewerPubkey, endpoint, params }, guard, request);
      });
    vi.mocked(saveActiveCommunityId).mockImplementationOnce(async (_pubkey, id) => {
      deck.workspaceSelectionListener?.(id);
    });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<BuzzChannels />);
      });
      await quiet();
      expect(writes.length).toBeGreaterThan(0);
      await quiet();
      expect(paintedRows(renderer)[0]?.room.id).toBe('22222222-2222-4222-8222-222222222222');
      expect(renderer.root.findAllByProps({ testID: 'rooms-loader-gate' })).toHaveLength(0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      for (const write of writes) await write();
      fetch.mockRestore();
    }
  });

  it('shows the first completed chat read while navigation transitions are held', async () => {
    // Android F02 / cold review entry: a completed server read must replace
    // the loader without requiring Activity recreation or another navigation.
    let reply!: (value: ChatListView) => void;
    deck.chatsResponse = new Promise<ChatListView>((resolve) => {
      reply = resolve;
    });
    deck.renderRows = true;
    transitions.held = true;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<BuzzChannels />);
      });
      await vi.waitFor(() => expect(deck.chatsReads).toBe(1));
      expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
      await act(async () =>
        reply(chatList({ id: 'first', text: 'Ready after sign-in', createdAt: 10 })),
      );
      await quiet();
      expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('Ready after sign-in');
      expect(renderer.root.findAllByProps({ testID: 'rooms-loader-gate' })).toHaveLength(0);
      act(() =>
        renderer.root
          .find((node: any) => node.type === 'ListItem' && node.props.testID === 'room-room-a')
          .props.onPress(),
      );
      expect(dispatchRoomOpenTap).toHaveBeenCalledWith('room-a', expect.anything());
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('starts at the saved deck with synchronous scoped rows before layout, pending invite and live reads', async () => {
    deck.pathname = '/';
    deck.holdLayouts = true;
    scope1.saveDeck();
    let releaseInvite!: (value: string | null) => void;
    deck.storedInvite = new Promise((resolve) => {
      releaseInvite = resolve;
    });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Index />);
      });
      expect(paintedRows(renderer)[0].latestMessage?.text).toBe('saved before effects');
      expect(router.replace).not.toHaveBeenCalled();
      expect(loadPendingInvite).not.toHaveBeenCalled();
      expect(deck.workspaceReads).toBe(0);
      expect(deck.chatsReads).toBe(0);
      await act(async () =>
        renderer.root.findByProps({ testID: 'room-list-idle' }).props.onLayout(),
      );
      await vi.waitFor(() => expect(loadPendingInvite).toHaveBeenCalled());
      expect(deck.chatsReads).toBe(0);
      await act(async () => releaseInvite(null));
      await vi.waitFor(() => expect(deck.chatsReads).toBe(1));
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('does not let a late pending invite overwrite a Room opened after cached paint', async () => {
    scope1.saveDeck();
    let releaseInvite!: (value: string | null) => void;
    deck.storedInvite = new Promise((resolve) => {
      releaseInvite = resolve;
    });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<BuzzChannels />);
      });
      await vi.waitFor(() => expect(loadPendingInvite).toHaveBeenCalled());
      await act(async () => deck.blur?.());
      await act(async () => releaseInvite('bzi_' + 'ab'.repeat(32)));
      expect(router.replace).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('never restores another viewer cache into the signed-in deck', async () => {
    deck.holdLayouts = true;
    scope1.saveDeck();
    vi.mocked(loadBuzzIdentity).mockResolvedValue({
      publicKey: 'other-viewer',
      secretKey: new Uint8Array(32),
    });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<BuzzChannels />);
      });
      expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
      expect(deck.chatsReads).toBe(0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('restores the retained root when Back returns from a review launch', async () => {
    // Android F02: the launch URL owns initial navigation, but Back must
    // reveal a usable signed-in deck rather than its abandoned load gate.
    deck.pathname = '/';
    deck.initialUrl = 'beeline://review/play-review-secret-value-0001';
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Index />);
      });
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/review/[secret]',
        params: { secret: 'play-review-secret-value-0001' },
      });
      expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
      // The root layout marks explicit navigation committed; the stack can
      // retain index under the review screen and its replacement chat deck.
      markInitialLandingResolved();
      await act(async () => {
        deck.blur?.();
      });
      vi.mocked(router.replace).mockClear();
      await act(async () => {
        deck.focusEffect?.();
        renderer.update(<Index />);
      });
      await quiet();
      expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('earlier');
      expect(renderer.root.findAllByProps({ testID: 'rooms-loader-gate' })).toHaveLength(0);
      expect(router.replace).not.toHaveBeenCalled();
      const reads = deck.chatsReads;
      await act(async () => {
        deck.blur?.();
      });
      await act(async () => {
        deck.focusEffect?.();
      });
      await quiet();
      expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('earlier');
      expect(deck.chatsReads).toBe(reads);
      expect(router.replace).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it.each([
    [
      'https://usebeeline.app/join/bzi_' + 'ab'.repeat(32),
      '/join/[token]',
      'token',
      'bzi_' + 'ab'.repeat(32),
    ],
    [
      'beeline://review/play-review-secret-value-0001',
      '/review/[secret]',
      'secret',
      'play-review-secret-value-0001',
    ],
    ['beeline://review/short', '/review/[secret]', 'secret', 'short'],
  ])(
    'keeps the explicit launch destination authoritative: %s',
    async (url, pathname, key, value) => {
      deck.pathname = '/';
      deck.initialUrl = url;
      scope1.saveDeck();
      let renderer!: ReactTestRenderer;
      try {
        await act(async () => {
          renderer = create(<Index />);
        });
        expect(router.replace).toHaveBeenCalledWith({ pathname, params: { [key]: value } });
        expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
        expect(deck.chatsReads).toBe(0);
      } finally {
        if (renderer) await act(async () => renderer.unmount());
      }
    },
  );

  it.each([false, true])(
    'keeps absent identity / unfinished naming in onboarding (naming=%s)',
    async (naming) => {
      deck.pathname = '/';
      deck.naming = naming;
      if (!naming) vi.mocked(loadBuzzIdentity).mockResolvedValue(null);
      let renderer!: ReactTestRenderer;
      try {
        await act(async () => {
          renderer = create(<Index />);
        });
        expect(router.replace).toHaveBeenCalledWith('/beeline/onboarding');
        expect(deck.chatsReads).toBe(0);
      } finally {
        if (renderer) await act(async () => renderer.unmount());
      }
    },
  );

  it('keeps unfinished naming authoritative when Back reveals an already-resolved root', async () => {
    markInitialLandingResolved();
    deck.pathname = '/';
    deck.naming = true;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Index />);
      });
      expect(router.replace).toHaveBeenCalledWith('/beeline/onboarding');
      expect(deck.chatsReads).toBe(0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });

  it('does not overwrite a tapped push when local restoration completes late, then shows the deck on Back', async () => {
    deck.pathname = '/';
    deck.holdLayouts = true;
    scope1.saveDeck();
    let restore!: (value: any) => void;
    vi.mocked(loadBuzzIdentity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          restore = resolve;
        }),
    );
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Index />);
      });
      suppressInitialLandingNavigation();
      deck.pathname = '/beeline/chat/pushed';
      await act(async () => renderer.update(<Index />));
      await act(async () =>
        restore({ publicKey: scope1.savedViewer, secretKey: new Uint8Array(32) }),
      );
      // The navigator covers the retained deck; a late restore must not navigate.
      expect(paintedRows(renderer)[0].latestMessage?.text).toBe('saved before effects');
      expect(router.replace).not.toHaveBeenCalled();
      deck.pathname = '/';
      await act(async () => renderer.update(<Index />));
      expect(paintedRows(renderer)[0].latestMessage?.text).toBe('saved before effects');
      expect(router.replace).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
    }
  });
});
