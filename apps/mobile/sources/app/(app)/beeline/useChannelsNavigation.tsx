import { useScopedCallbacks } from '@/buzz/use-stable';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { dispatchRoomOpenTap, warmRoomRouteCode } from '@/buzz/room-open-prefetch';
import { useJoinChat } from '@/ui/screens/chats/use-join-chat';
import { useNewThread } from '@/ui/screens/chats/use-new-thread';
import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import type { DeckPresentation } from './useChannelsPresentation';
import type { useChannelsRoomActions } from './useChannelsRoomActions';
import type { DeckState } from './useChannelsRouteState';

/** Opening chats, threads and Workspaces from the deck, and joining a public chat. */
export function useChannelsNavigation(
  { identity, chatStore, setError, transport }: DeckState,
  { activeCommunityId, togglePin }: DeckPresentation,
  { roomListGestures, swipeableRefs }: ReturnType<typeof useChannelsRoomActions>,
) {
  useEffect(() => {
    if (Platform.OS === 'web') warmRoomRouteCode();
  }, []);

  const openRoom = useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        navigate: (id) => {
          if (identity && activeCommunityId) void saveLastViewedChannel(identity.publicKey, activeCommunityId, id);
          navigateToRoom(router, id);
        },
      });
    },
    [activeCommunityId, identity],
  );

  const openNewThread = useNewThread(() => transport);
  // A list update changes one DTO, not every Room's event handlers.
  const rowActions = useScopedCallbacks(
    {
      press: (roomId: string) => {
        if (!roomListGestures.canInteract()) return;
        swipeableRefs.current.get(roomId)?.close();
        openRoom(roomId);
      },
      pin: (roomId: string) => {
        if (roomListGestures.canInteract()) void togglePin(roomId);
      },
      thread: (roomId: string, cornerId: string, name: string) => {
        if (roomListGestures.canInteract()) router.push(cornerHref(cornerId, roomId, name));
      },
      newThread: (roomId: string) => {
        if (roomListGestures.canInteract()) void openNewThread(roomId);
      },
    },
    `${identity?.publicKey ?? ''}:${activeCommunityId ?? ''}`,
  );

  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return;
      if (identity) void saveActiveCommunityId(identity.publicKey, workspaceId);
      router.replace({ pathname: '/beeline/channels', params: { communityId: workspaceId } });
    },
    [identity],
  );

  const refreshList = useCallback(() => chatStore.current?.force(), []);
  const { joining, join } = useJoinChat(identity?.publicKey, refreshList, openRoom, setError);
  return { selectWorkspace, rowActions, openRoom, joining, join };
}
