import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { useDesktopLayout } from '@/buzz/desktop-layout-state';
import { removeRoomSearchDrafts } from '@/buzz/room-search-drafts';
import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { saveActiveCommunityId, subscribeActiveCommunityId } from '@/buzz/community-storage';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { desktopWorkspaceRoute } from '@/buzz/desktop-workbench-state';
import { useRoomPins } from '@/buzz/room-list-preferences';
import { useRoomCornerSummaries } from '@/buzz/room-corner-store';
import { dispatchRoomOpenTap, warmRoomRouteCode } from '@/buzz/room-open-prefetch';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { chatListSnapshot, refreshChatList, useChatList } from '@/buzz/chat-list-store';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { ROOMS_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { DesktopWorkspaceRail } from '@/components/buzz/DesktopWorkspaceRail';
import { messageSearchHref, useMessageSearch } from '@/buzz/use-message-search';
import { BuzzRigTransport } from '@/sync/transport';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { useHeaderHeight, useIsDesktop } from '@/utils/responsive';
import { isTauri } from '@/utils/isTauri';
import { Copy, SafeTop, T } from '@/ui/grammar';
import { SIDE_PLACES, SidePlaceRow, type SidePlace } from '@/ui/screens/chats/SidePlaces';
import { ChatListHeader, CLOSED_SEARCH, type ChatSearch } from '@/ui/screens/chats/ChatListHeader';
import { ChatRow, JoinableChats } from '@/ui/screens/chats/ChatTree';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { filterChats } from '@/ui/screens/chats/chat-tree-model';
import { MessageMatches } from '@/ui/screens/chats/MessageMatches';
import { useJoinChat } from '@/ui/screens/chats/use-join-chat';
import { useNewThread } from '@/ui/screens/chats/use-new-thread';
import {
  type RoomViewIdentity,
  type WorkspaceListView,
  isWorkspaceListView,
} from '@beeline/buzz-client';
import { useGlobalSearchParams, usePathname, useRouter, type Href } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';
import { ScrollView, Separator, XStack, YStack } from 'tamagui';

function selectedRoomId(pathname: string): string | null {
  const prefix = '/beeline/chat/';
  if (!pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length).split('/')[0]!);
  } catch {
    return pathname.slice(prefix.length).split('/')[0] ?? null;
  }
}

function firstParam(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

/** One server-backed desktop pane for Workspace and Room movement. */
export const SidebarView = React.memo(function SidebarView() {
  React.useEffect(() => {
    if (Platform.OS === 'web') warmRoomRouteCode();
  }, []);
  const { showRoomList } = useDesktopLayout();
  const headerHeight = useHeaderHeight();
  const macTitlebarInset =
    isTauri() && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
      ? headerHeight
      : 0;
  const isDesktop = useIsDesktop();
  const router = useRouter();
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams<{
    communityId?: string | string[];
    parent?: string | string[];
  }>();
  const routeWorkspaceId = firstParam(routeParams.communityId);
  // A corner promoted into the main pane still belongs beneath its parent
  // Room in the permanent list. The route's parent hint is presentation-only,
  // but it is enough to keep that already-loaded navigation family expanded.
  const promotedCornerParentId = firstParam(routeParams.parent);
  const activeRoomId = promotedCornerParentId ?? selectedRoomId(pathname);
  const workspaceIdRef = React.useRef<string | null>(null);
  const [client, setClient] = React.useState<RoomViewClient | null>(null);
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
  const [identityPubkey, setIdentityPubkey] = React.useState<string | null>(null);
  const [viewerIdentity, setViewerIdentity] = React.useState<RoomViewIdentity | null>(null);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceListView['workspaces']>([]);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState<ChatSearch>(CLOSED_SEARCH);
  const query = search.open ? search.query : '';
  React.useEffect(() => { void removeRoomSearchDrafts(); }, []);
  React.useEffect(() => {
    setSearch(CLOSED_SEARCH);
  }, [pathname, workspaceId, identityPubkey]);
  const [navigationError, setNavigationError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const refreshedForWorkspaceIds = React.useRef(new Set<string>());
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = React.useState(false);
  const attentionWorkspaceIds = new Set(workspaces.filter((workspace) => workspace.attention).map((workspace) => workspace.id));
  const storedWorkspaceId = useActiveCommunityId();
  const storedWorkspaceKnown = storedWorkspaceId !== undefined;

  React.useEffect(() => {
    if (!storedWorkspaceKnown) return;
    const stored = storedWorkspaceId;
    let cancelled = false;
    let stopWorkspaces: (() => void) | undefined;
    setNavigationError(null);
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) return;
      const baseUrl = await getEffectiveRelayUrl();
      const address = surfaceAddress(baseUrl, identity.publicKey, '/workspaces');
      const cached = await mobileSurfaceCache.read(address, isWorkspaceListView);
      if (cancelled) return;
      const selected = cached?.workspaces.some((workspace) => workspace.id === routeWorkspaceId)
        ? routeWorkspaceId!
        : cached?.workspaces.some((workspace) => workspace.id === stored)
          ? stored
          : (cached?.workspaces[0]?.id ?? stored);
      setClient(new RoomViewClient({ baseUrl, identity }));
      setRelayUrl(baseUrl);
      setIdentityPubkey(identity.publicKey);
      if (cached) {
        setViewerIdentity(cached.viewer);
        setWorkspaces(cached.workspaces);
      }
      workspaceIdRef.current = selected;
      setWorkspaceId(selected);
      if (routeWorkspaceId && selected === routeWorkspaceId && selected !== stored)
        void saveActiveCommunityId(identity.publicKey, selected);
      void new BuzzRigTransport(identity).surfaceSubscribe([], (event) => {
        if (!cancelled && invalidatesWorkspaceList(event)) setRefreshNonce((nonce) => nonce + 1);
      }).then((stop) => {
        if (cancelled) stop();
        else stopWorkspaces = stop;
      });
    })().catch((reason) => {
      if (!cancelled) setNavigationError(appErrorCopy(reason, 'Saved Workspaces are unavailable on this device.'));
    });
    return () => {
      cancelled = true;
      stopWorkspaces?.();
    };
  }, [storedWorkspaceKnown]);

  React.useEffect(() => {
    if (!client || !relayUrl || !identityPubkey) return;
    let cancelled = false;
    const address = surfaceAddress(relayUrl, identityPubkey, '/workspaces');
    const stop = mobileSurfaceCache.subscribe(address, () => {
      const cached = mobileSurfaceCache.peek(address, isWorkspaceListView);
      if (!cancelled) {
        if (cached) setNavigationError(null);
        setViewerIdentity(cached?.viewer ?? null);
        setWorkspaces(cached?.workspaces ?? []);
      }
    });
    // The mounted deck owns its subscription and covering read. Sidebar rows
    // consume the same projection without starting a second request.
    if (!pathname.startsWith('/beeline/channels'))
      void mobileSurfaceCache.fetch(address, isWorkspaceListView, () => client.workspaces()).then((list) => {
      if (cancelled || !list) return;
      setNavigationError(null);
      const selected = workspaceIdRef.current;
      if (selected && !list.workspaces.some((workspace) => workspace.id === selected)) {
        const nextId = list.workspaces[0]?.id ?? null;
        workspaceIdRef.current = nextId;
        setWorkspaceId(nextId);
        void saveActiveCommunityId(identityPubkey, nextId);
        router.replace(nextId
          ? { pathname: '/beeline/channels', params: { communityId: nextId } }
          : '/beeline/community');
      }
    }).catch((reason) => {
      if (!cancelled) setNavigationError(appReadErrorCopy(reason));
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [client, identityPubkey, relayUrl, refreshNonce]);

  // The app-level Room list owns its live watch, so the Sidebar stays current
  // whether or not the deck is mounted.
  const chatListKey = React.useMemo(
    () =>
      relayUrl && identityPubkey && workspaceId
      ? { relayUrl, viewerPubkey: identityPubkey, workspaceId }
      : null,
    [identityPubkey, relayUrl, workspaceId],
  );
  const surface = useChatList(chatListKey, {
    onError: (reason) => setNavigationError(appReadErrorCopy(reason)),
  });
  // An identity-wide change (a Room joined or left) reads the list again; the
  // mounted deck already reads for its own Workspace watch.
  React.useEffect(() => {
    if (refreshNonce === 0 || !chatListKey || pathname.startsWith('/beeline/channels')) return;
    refreshChatList(chatListKey);
  }, [refreshNonce]);

  React.useEffect(() => {
    if (!identityPubkey) return;
    return subscribeActiveCommunityId(identityPubkey, (nextWorkspaceId) => {
      if (!nextWorkspaceId) {
        workspaceIdRef.current = null;
        setWorkspaceId(null);
        setRefreshNonce((nonce) => nonce + 1);
        return;
      }
      if (!workspaces.some((workspace) => workspace.id === nextWorkspaceId)) {
        // A Workspace just created or joined: read the list again — once per
        // id, so a stale stored id (a deleted Workspace) cannot loop.
        if (!refreshedForWorkspaceIds.current.has(nextWorkspaceId)) {
          refreshedForWorkspaceIds.current.add(nextWorkspaceId);
          setRefreshNonce((nonce) => nonce + 1);
        }
        return;
      }
      if (workspaceIdRef.current === nextWorkspaceId) return;
      workspaceIdRef.current = nextWorkspaceId;
      setWorkspaceId(nextWorkspaceId);
      });
  }, [identityPubkey, workspaces, relayUrl]);

  React.useEffect(() => {
    if (
      !routeWorkspaceId ||
      !workspaces.some((workspace) => workspace.id === routeWorkspaceId) ||
      workspaceIdRef.current === routeWorkspaceId
    ) {
      return;
    }
    workspaceIdRef.current = routeWorkspaceId;
    setWorkspaceId(routeWorkspaceId);
    if (identityPubkey) void saveActiveCommunityId(identityPubkey, routeWorkspaceId);
  }, [identityPubkey, routeWorkspaceId, workspaces, relayUrl]);

  const { pinned, togglePin, pinError } = useRoomPins(identityPubkey, workspaceId);
  const cornerSummaries = useRoomCornerSummaries();
  const filteredChats = React.useMemo(
    () => filterChats(surface?.chats ?? [], query, search.open ? search.chips : [], pinned,
      (roomId) => cornerSummaries.get(roomId)?.openCorners),
    [query, search, pinned, surface?.chats, cornerSummaries],
  );
  const messageSearch = useMessageSearch(
    client ? (id, text, before, signal) => client.searchMessages(id, text, before, signal) : null,
    workspaceId,
    query,
  );
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  // ChatListView carries workspace.role; the server's viewer.permissions.manage
  // is the same boolean (`role !== 'member'`). Do not invent a second gate.
  const canManageWorkspace = isWorkspaceManagerRole(surface?.workspace.role);
  const viewerIsAgent = surface?.viewer.kind === 'agent';
  const canCreateRoom = !viewerIsAgent && canManageWorkspace;
  const needsYouCount = useNeedsYouCount(workspaceId, surface);
  const placeSelected = (place: SidePlace['key']) => pathname.startsWith(`/beeline/${place}`);
  const openRoom = React.useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        navigate: (id) => {
          setSearch(CLOSED_SEARCH);
          navigateToRoom(router, id);
        },
      });
    },
    [router],
  );
  // Quiet lists keep their ages until real list activity. Route changes retain
  // the same timestamp so unrelated conversation rows can stay memoized.
  const ageNow = React.useMemo(() => Date.now(), [surface?.chats]);
  const openThread = React.useCallback((roomId: string, cornerId: string, name: string) => {
    router.push(cornerHref(cornerId, roomId, name));
  }, [router]);
  const openNewThread = useNewThread(async () => {
    const identity = await loadBuzzIdentity();
    return identity ? new BuzzRigTransport(identity) : null;
  });
  const newThread = React.useCallback((roomId: string) => void openNewThread(roomId), [openNewThread]);
  const refreshList = React.useCallback(() => { if (chatListKey) refreshChatList(chatListKey); }, [chatListKey]);
  const { joining, join } = useJoinChat(identityPubkey, refreshList, openRoom, setNavigationError);
  const openPlace = React.useCallback((place: SidePlace['key']) => {
    if (place === 'tray')
      router.push({ pathname: '/beeline/tray', params: { communityId: workspaceId ?? '', workspaceName: activeWorkspace?.name ?? '' } } as never);
    else router.push(`/beeline/${place}` as Href);
  }, [activeWorkspace?.name, router, workspaceId]);

  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (event.key === 'Escape' && workspaceSwitcherOpen) {
        event.preventDefault();
        setWorkspaceSwitcherOpen(false);
        return;
      }
      if (
        !editing &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        setWorkspaceSwitcherOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearch((current) => (current.open ? current : { ...CLOSED_SEARCH, open: true }));
        return;
      }
      if (!editing && event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const index = Math.max(
          0,
          filteredChats.findIndex((item) => item.room.id === activeRoomId),
        );
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = filteredChats[(index + delta + filteredChats.length) % filteredChats.length];
        if (next) openRoom(next.room.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeRoomId, filteredChats, openRoom, workspaceSwitcherOpen]);

  const selectWorkspace = React.useCallback(
    (nextId: string) => {
      setWorkspaceSwitcherOpen(false);
      if (nextId === workspaceIdRef.current) return;
      workspaceIdRef.current = nextId;
      setWorkspaceId(nextId);
      const cached = relayUrl && identityPubkey
        ? chatListSnapshot({ relayUrl, viewerPubkey: identityPubkey, workspaceId: nextId })
        : null;
      if (identityPubkey) void saveActiveCommunityId(identityPubkey, nextId);
      router.push(desktopWorkspaceRoute(nextId, cached?.chats.map((chat) => chat.room.id) ?? [], null) as Href);
    },
    [identityPubkey, relayUrl, router],
  );

  const canStartChat = Boolean(workspaceId) && canCreateRoom;
  return (
    <YStack flex={1} minHeight={0}>
      {macTitlebarInset ? <YStack height={macTitlebarInset} /> : null}
      {(!isDesktop || showRoomList) && (
        <YStack flex={1} minHeight={0} borderRightWidth={1} borderColor="stroke" backgroundColor="canvas" testID="desktop-navigation-pane">
          {isDesktop ? null : <SafeTop />}
          <ChatListHeader
            workspaceName={activeWorkspace?.name ?? WORKSPACE_LABEL}
            onWorkspace={() => setWorkspaceSwitcherOpen((open) => !open)}
            onNew={canStartChat
              ? () => router.push({ pathname: '/beeline/channels', params: { communityId: workspaceId!, newRoom: String(Date.now()) } } as Href)
              : undefined}
            search={search}
            onSearch={setSearch}
          />
          <YStack paddingHorizontal="2" paddingVertical="2" gap="1">
            {SIDE_PLACES.map((place) => (
              <SidePlaceRow
                key={place.key}
                place={place}
                selected={placeSelected(place.key)}
                count={place.key === 'tray' ? needsYouCount : undefined}
                onPress={() => openPlace(place.key)}
              />
            ))}
          </YStack>
          <Separator borderColor="stroke" />
          <XStack paddingHorizontal="4" paddingTop="3"><T v="metaStrong" color="secondary">Chats</T></XStack>
          {pinError ? <YStack paddingHorizontal="4" paddingTop="2"><Copy small color="removed">{pinError}</Copy></YStack> : null}
          <ScrollView flex={1} minHeight={0} testID="desktop-chat-tree">
            {navigationError ? (
              <YStack padding="4"><Copy small color="removed">{navigationError}</Copy></YStack>
            ) : !surface ? (
              <YStack padding="4" testID="desktop-rooms-loader">
                <SurfaceGlyphLoader compact />
              </YStack>
            ) : !filteredChats.length ? (
              <YStack padding="4">
                <Copy quiet>{search.open ? 'No chats match.' : `No ${ROOMS_LABEL.toLowerCase()} or direct messages yet.`}</Copy>
              </YStack>
            ) : (
              filteredChats.map((item, index) => (
                <ChatRow
                  key={item.room.id}
                  item={item}
                  viewer={identityPubkey ?? undefined}
                  now={ageNow}
                  first={index === 0}
                  selected={isDesktop && activeRoomId === item.room.id}
                  pinned={pinned.includes(item.room.id)}
                  onOpen={openRoom}
                  onPin={togglePin}
                  onOpenThread={openThread}
                  onNewThread={viewerIsAgent ? undefined : newThread}
                />
              ))
            )}
            <MessageMatches
              search={messageSearch}
              now={ageNow}
              onOpen={(result) => {
                if (workspaceId) {
                  setSearch(CLOSED_SEARCH);
                  router.push(messageSearchHref(result, workspaceId) as Href);
                }
              }}
            />
            {search.open || !surface ? null : (
              <JoinableChats chats={surface.joinable ?? []} joining={joining} onJoin={(id, name) => void join(id, name)} />
            )}
          </ScrollView>
          {isDesktop && (
            <DesktopWorkspaceRail
              activeWorkspaceId={workspaceId}
              onAdd={() => {
                setWorkspaceSwitcherOpen(false);
                router.push('/beeline/community' as Href);
              }}
              onClose={() => setWorkspaceSwitcherOpen(false)}
              onOpenAccount={() => {
                setWorkspaceSwitcherOpen(false);
                router.push('/beeline/settings' as Href);
              }}
              onSelect={selectWorkspace}
              open={workspaceSwitcherOpen}
              viewerAvatarUrl={viewerIdentity?.avatar}
              viewerFace={viewerIdentity?.face}
              viewerName={viewerIdentity?.name}
              viewerPubkey={identityPubkey ?? undefined}
              workspaces={workspaces.map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
                avatar: workspace.avatar,
                roomCount: workspace.roomCount ?? 0,
                needsAttention: attentionWorkspaceIds.has(workspace.id),
              }))}
            />
          )}
        </YStack>
      )}
    </YStack>
  );
});
