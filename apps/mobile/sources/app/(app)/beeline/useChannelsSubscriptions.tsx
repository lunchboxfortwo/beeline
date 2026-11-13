import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
import { takePendingBrowserShare } from '@/buzz/pending-browser-share';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { acquireChatList } from '@/buzz/chat-list-store';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { loadPendingInvite } from '@/buzz/pending-invite';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration } from '@/sync/client-reset';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { isWorkspaceListView } from '@beeline/buzz-client';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { startTransition, useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { AGE_TICK_MS } from './channels';
import { afterFirstFrame } from '@/navigation/initial-landing';
import type { DeckState } from './useChannelsRouteState';

/** The deck's live watch, covering reads and visit clock; the hook paints nothing itself. */
export function useChannelsSubscriptions(
  {
    drawn, setConfirmedWorkspaceCount, deckMissedRef, deckVisible, setError, identity, relayUrl,
    deckFocusedRef, transport, setDeletedWorkspaceNotice, selectedId, chatStore, setChatList,
    setRefreshing, readWorkspaceRef, setNeedsYouSignal, retryGeneration, setAgeNow,
  }: DeckState,
  activeCommunityId: string | null,
  refreshMissed: () => void,
): void {
  useEffect(() => {
    if (!drawn) return;
    setConfirmedWorkspaceCount(null);
    let cancelled = false;
    const identityGeneration = clientResetGeneration();
    deckMissedRef.current = { workspaces: false };
    const activation = AppState.addEventListener('change', (state) => {
      if (
        state === 'active' &&
        !cancelled &&
        identityGeneration === clientResetGeneration() &&
        deckVisible()
      )
        refreshMissed();
    });
    let unsubscribeWorkspaces: (() => void) | undefined;
    let unsubscribeChats: (() => void) | undefined;
    let readWorkspace: (() => Promise<void>) | undefined;
    let releaseChats: (() => void) | undefined;
    void (async () => {
      setError(null);
      const nextIdentity = identity;
      const nextRelayUrl = relayUrl;
      const pendingInvite = await loadPendingInvite();
      if (cancelled) return;
      // An invite opened before sign-in outranks every other landing.
      if (pendingInvite && deckFocusedRef.current) {
        if (!cancelled)
          router.replace({ pathname: '/join/[token]', params: { token: pendingInvite } });
        return;
      }
      if (cancelled) return;
      const browserShareId = deckFocusedRef.current ? await takePendingBrowserShare() : null;
      if (cancelled) return;
      if (browserShareId && deckFocusedRef.current) {
        router.replace({ pathname: '/beeline/browser-share', params: { id: browserShareId } });
        return;
      }
      const nextTransport = transport;
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      const relayPromise = nextTransport.ensureClient();

      const workspaceCacheAddress = surfaceAddress(
        nextRelayUrl,
        nextIdentity.publicKey,
        '/workspaces',
      );
      const cachedWorkspaces = mobileSurfaceCache.peek(workspaceCacheAddress, isWorkspaceListView);
      if (cancelled) return;
      let selectedWorkspaceRemoved = false;

      readWorkspace = async () => {
        if (cancelled) return;
        try {
          deckMissedRef.current.workspaces = false;
          const value = await mobileSurfaceCache.fetch(workspaceCacheAddress, isWorkspaceListView, () =>
            http.workspaces(),
          );
          if (cancelled) return;

          // Null: an eviction overtook the read; there is nothing to paint.
          if (!value) return;
          setConfirmedWorkspaceCount(value.workspaces.length);
          if (value.deletedNotices?.length) {
            setDeletedWorkspaceNotice('This workspace was deleted by its owner');
          }
          if (!selectedId || !value.workspaces.some((workspace) => workspace.id === selectedId)) {
            selectedWorkspaceRemoved = true;
            unsubscribeChats?.();
            unsubscribeChats = undefined;
            chatStore.current = null;
            if (chats) void chats.remove();
            setChatList(null);
            setRefreshing(false);
            setError(null);
            const nextId = value.workspaces[0]?.id ?? null;
            void saveActiveCommunityId(nextIdentity.publicKey, nextId);
            if (nextId && deckFocusedRef.current) {
              router.replace({
                pathname: '/beeline/channels',
                params: { communityId: nextId },
              } as never);
            }
          }
        } catch (reason) {
          if (!cancelled) {
            setError(appReadErrorCopy(reason));
          }
        }
      };
      readWorkspaceRef.current = readWorkspace;

      // The app-level Room list owns its live watch, covering reads and disk
      // copy; the deck paints it and reports whether it is on view.
      const chats = selectedId
        ? acquireChatList(
            {
              relayUrl: nextRelayUrl,
              viewerPubkey: nextIdentity.publicKey,
              workspaceId: selectedId,
            },
            {
              visible: deckVisible,
              onRead: () => {
                if (selectedWorkspaceRemoved) return;
                setNeedsYouSignal((signal) => signal + 1);
                setRefreshing(false);
                setError(null);
              },
              onError: (reason) => {
                if (selectedWorkspaceRemoved) return;
                setRefreshing(false);
                setError(appReadErrorCopy(reason));
                // A deleted Workspace's old route may be restored from storage
                // before the authoritative workspace read has reconciled it.
                if (
                  reason instanceof RoomViewHttpError &&
                  (reason.status === 403 || reason.status === 404)
                )
                  void readWorkspace?.();
              },
            },
          )
        : null;
      releaseChats = () => chats?.release();
      if (chats) {
        chatStore.current = chats;
        const paint = () => {
          if (!selectedWorkspaceRemoved) setChatList(chats.current());
        };
        paint();
        // A store another screen already read is current: it seeds the badge.
        if (chats.confirmed()) setNeedsYouSignal((signal) => signal + 1);
        // Saved Rooms are the first usable deck; paint them immediately.
        // Confirmed live reconciliation still yields to Room or push navigation.
        unsubscribeChats = chats.subscribe(() => {
          // Removed private state must clear even while the list is covered.
          if (!deckVisible() && chats.current() !== null) return;
          if (chats.confirmed()) startTransition(paint);
          else paint();
        });
      }
      const relay = await relayPromise;
      if (cancelled) return;

      const workspaceListenReady = relay
        .surfaceSubscribe(
          cachedWorkspaces?.watchFilters ?? [
            { kinds: [9000, 9001, 9007], '#p': [nextIdentity.publicKey] },
          ],
          (event) => {
            if (
              cancelled ||
              identityGeneration !== clientResetGeneration() ||
              !invalidatesWorkspaceList(event)
            )
              return;
            if (deckVisible()) void readWorkspace?.();
            else deckMissedRef.current.workspaces = true;
          },
        )
        .then((stop) => {
          if (cancelled) stop();
          else unsubscribeWorkspaces = stop;
        });
      await workspaceListenReady;
      await readWorkspace();
    })().catch((reason) => {
      if (!cancelled) setError(appReadErrorCopy(reason));
    });
    return () => {
      cancelled = true;
      activation.remove();
      unsubscribeWorkspaces?.();
      unsubscribeChats?.();
      releaseChats?.();
      readWorkspaceRef.current = null;
      chatStore.current = null;
    };
  }, [drawn, identity, relayUrl, transport, selectedId, deckVisible, refreshMissed, retryGeneration]);


  useFocusEffect(
    useCallback(() => {
      deckFocusedRef.current = true;
      // Back reveals the retained list first; catch-up and age labels must not
      // rebuild its rows during the navigation commit.
      const cancelFrame = afterFirstFrame(() => {
        refreshMissed();
        setAgeNow(Date.now());
      });
      const timer = setInterval(() => setAgeNow(Date.now()), AGE_TICK_MS);
      return () => {
        deckFocusedRef.current = false;
        cancelFrame();
        clearInterval(timer);
      };
    }, [activeCommunityId, refreshMissed]),
  );
}
