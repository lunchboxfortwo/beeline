import { appErrorCopy } from '@/buzz/app-error-copy';
import { roomRowName } from '@/buzz/room-list-row';
import { useRoomListGestures } from '@/buzz/use-room-list-gestures';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Modal } from '@/modal';
import { type ChatListItem } from '@beeline/buzz-client';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef } from 'react';
import { Swipeable } from 'react-native-gesture-handler';
import type { DeckState } from './useChannelsRouteState';

/** Swipe gestures and the swipe actions: leave a chat, close a direct message. */
export function useChannelsRoomActions({ transport, chatStore, setError }: DeckState) {
  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const roomListGestures = useRoomListGestures();

  const handleCloseChat = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot close yet', 'Connection is still starting. Try again.');
        return;
      }
      try {
        await transport.closeChat(item.room.id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        setError(appErrorCopy(reason, `Could not close chat.`));
      }
    },
    [transport],
  );

  const handleLeaveRoom = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot leave yet', 'Connection is still starting. Try again.');
        return;
      }
      const heading = roomRowName(item);
      const title = `${heading.sigil}${heading.name}`;
      try {
        const left = await leaveRoomWithConfirmation(
          title,
          item.leaveDeletesRoom === true,
          (confirmDelete) => transport.leaveRoom(item.room.id, confirmDelete),
        );
        if (!left) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        setError(appErrorCopy(reason, `Could not leave ${ROOM_LABEL}.`));
      }
    },
    [transport],
  );
  return { roomListGestures, swipeableRefs, handleLeaveRoom, handleCloseChat };
}
