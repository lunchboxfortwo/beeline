import { useTextDraft } from '@/buzz/use-text-draft';
import { useRoomSearch } from '@/buzz/use-room-search';
import { useRoomPins } from '@/buzz/room-list-preferences';
import { useRoomCornerSummaries } from '@/buzz/room-corner-store';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { useMessageSearch } from '@/buzz/use-message-search';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { filterChats, type SearchChip } from '@/ui/screens/chats/chat-tree-model';
import type { ChatSearch } from '@/ui/screens/chats/ChatListHeader';
import { useCallback, useMemo, useState } from 'react';
import type { DeckState } from './useChannelsRouteState';

/** What the deck paints: the Workspace, the filtered chats, search and the New chat draft. */
export function useChannelsPresentation({ workspaceList, requestedWorkspaceId, chatList, identity, relayUrl }: DeckState) {
  const communities = useMemo(
    () => workspaceList?.workspaces.map(workspaceRailItem) ?? [],
    [workspaceList],
  );
  const activeCommunityId =
    requestedWorkspaceId ?? chatList?.workspace.id ?? communities[0]?.communityId ?? null;
  const activeCommunity =
    communities.find((entry) => entry.communityId === activeCommunityId) ?? null;
  const viewerIsAgent = chatList?.viewer.kind === 'agent';
  const canManageWorkspace =
    chatList?.workspace.role === 'owner' || chatList?.workspace.role === 'admin';
  const [roomName, setRoomName, roomNameDraft] = useTextDraft(
    `new-room:${activeCommunityId}`,
    '',
    identity?.publicKey ?? null,
  );
  const { query, setQuery, searchOpen, setSearchOpen } = useRoomSearch(
    activeCommunityId ?? null,
    identity?.publicKey ?? null,
  );
  const [chips, setChips] = useState<SearchChip[]>([]);
  const search: ChatSearch = useMemo(
    () => ({ open: searchOpen, query, chips: searchOpen ? chips : [] }),
    [chips, query, searchOpen],
  );
  const setSearch = useCallback((next: ChatSearch) => {
    setSearchOpen(next.open);
    setQuery(next.open ? next.query : '');
    setChips(next.open ? next.chips : []);
  }, [setQuery, setSearchOpen]);
  const { pinned, togglePin, pinError } = useRoomPins(
    identity?.publicKey,
    activeCommunityId,
  );
  const cornerSummaries = useRoomCornerSummaries();
  const rows = useMemo(
    () => filterChats(chatList?.chats ?? [], search.query, search.chips, pinned,
      (roomId) => cornerSummaries.get(roomId)?.openCorners),
    [chatList?.chats, search, pinned, cornerSummaries],
  );
  const searchClient = useMemo(
    () => (identity && relayUrl ? new RoomViewClient({ baseUrl: relayUrl, identity }) : null),
    [identity, relayUrl],
  );
  const messageSearch = useMessageSearch(
    searchClient
      ? (workspaceId, text, before, signal) =>
          searchClient.searchMessages(workspaceId, text, before, signal)
      : null,
    activeCommunityId,
    query,
  );
  return {
    viewerIsAgent, canManageWorkspace, activeCommunityId, togglePin, roomName, roomNameDraft,
    activeCommunity, communities, search, setSearch, pinError, setRoomName, rows, messageSearch,
    pinned,
  };
}

export type DeckPresentation = ReturnType<typeof useChannelsPresentation>;
