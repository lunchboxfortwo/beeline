import { appErrorCopy } from '@/buzz/app-error-copy';
import { roomRowName } from '@/buzz/room-list-row';
import { useRoomListGestures } from '@/buzz/use-room-list-gestures';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Modal } from '@/modal';
import { type ChatListItem } from '@beeline/buzz-client';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Swipeable } from 'react-native-gesture-handler';
import type { DeckState } from './useChannelsRouteState';

/** Swipe gestures and the swipe actions: leave a chat, close a direct message.
 * A confirmed leave or close hides its row at once and restores it on failure.
 * `rows` are the rows on screen (search may filter them); `allRows` is the
 * unfiltered server list, the only list that may clear a done marker. */
export function useChannelsRoomActions(
  { transport, chatStore, setError }: DeckState,
  rows: readonly ChatListItem[],
  allRows: readonly ChatListItem[] = rows,
) {
  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const roomListGestures = useRoomListGestures();
  // Pending ids stay hidden until the call settles; done ids until the list drops them.
  const [hidden, setHidden] = useState<ReadonlyMap<string, 'pending' | 'done'>>(() => new Map());
  const mark = useCallback((roomId: string, state: 'pending' | 'done' | null) => {
    setHidden((current) => {
      const next = new Map(current);
      if (state) next.set(roomId, state);
      else next.delete(roomId);
      return next;
    });
  }, []);
  useEffect(() => {
    const present = new Set(allRows.map((row) => row.room.id));
    const gone = [...hidden].filter(([roomId, state]) => state === 'done' && !present.has(roomId));
    if (!gone.length) return;
    setHidden((current) => {
      const next = new Map(current);
      for (const [roomId] of gone) next.delete(roomId);
      return next;
    });
  }, [allRows, hidden]);
  const visibleRows = useMemo(
    () => (hidden.size ? rows.filter((row) => !hidden.has(row.room.id)) : rows),
    [rows, hidden],
  );

  const handleCloseChat = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot close yet', 'Connection is still starting. Try again.');
        return;
      }
      mark(item.room.id, 'pending');
      try {
        await transport.closeChat(item.room.id);
        mark(item.room.id, 'done');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        mark(item.room.id, null);
        setError(appErrorCopy(reason, `Could not close chat.`));
      }
    },
    [transport, mark],
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
          (confirmDelete) => {
            // Called only after the person confirms: the row goes at once.
            mark(item.room.id, 'pending');
            return transport.leaveRoom(item.room.id, confirmDelete);
          },
        );
        if (!left) {
          // The person declined the second, last-admin confirmation.
          mark(item.room.id, null);
          return;
        }
        mark(item.room.id, 'done');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        mark(item.room.id, null);
        setError(appErrorCopy(reason, `Could not leave ${ROOM_LABEL}.`));
      }
    },
    [transport, mark],
  );
  return { roomListGestures, swipeableRefs, handleLeaveRoom, handleCloseChat, visibleRows };
}
