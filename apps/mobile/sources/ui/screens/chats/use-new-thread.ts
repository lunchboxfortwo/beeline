import { useCallback, useRef } from 'react';
import { router } from 'expo-router';
import { cornerHref, type CornerReturnTarget } from '@/buzz/corner-navigation';
import { cornerOpenTappedAgain } from '@/buzz/corner-open-status';
import type { CornerOpenAttempt } from '@/buzz/open-random-corner';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import type { BuzzRigTransport } from '@/sync/transport';

/**
 * Long-press of a chat row's mark: a new randomly named thread in that chat
 * (`createHumanCorner`), then open it. One open at a time; a second press while
 * one is pending says so. `transport` resolves lazily for surfaces that do not
 * hold one yet.
 */
export function useNewThread(
  transport: () => BuzzRigTransport | null | undefined | Promise<BuzzRigTransport | null | undefined>,
  returnTo?: CornerReturnTarget,
) {
  const resolve = useRef(transport);
  resolve.current = transport;
  const opening = useRef(false);
  const open = useCallback(async (roomId: string, attempt?: CornerOpenAttempt): Promise<void> => {
    if (opening.current) return cornerOpenTappedAgain();
    opening.current = true;
    try {
      const client = await resolve.current();
      await openRoomListCorner({
        roomId,
        attempt,
        createCorner: client
          ? (id, title, cornerId) => client.createHumanCorner(id, title, undefined, true, cornerId)
          : null,
        openCorner: (cornerId, title) => router.push(cornerHref(cornerId, roomId, title, returnTo)),
        retry: (failed) => void open(roomId, failed),
      });
    } finally {
      opening.current = false;
    }
  }, [returnTo]);
  return open;
}
