import { prefetchRoomOpen } from '@/push/push-room-prefetch';
import { markRoomOpen } from '@/buzz/room-open-trace';

/** Start a missing-row read at the tap without waiting for it to navigate. */
export function dispatchRoomOpenTap(
  roomId: string,
  next: {
    navigate: (roomId: string) => void;
  },
): void {
  markRoomOpen('nav-dispatch', roomId);
  prefetchRoomOpen(roomId);
  next.navigate(roomId);
}


let roomRouteCode: Promise<unknown> | undefined;

/** Evaluate the shared Room renderer while the deck is open, without mounting
 * a conversation or reading any Room. A tap still owns its scoped data read. */
export function warmRoomRouteCode(): void {
  roomRouteCode ??= import('@/app/(app)/beeline/chat/[channelId]').catch(() => {
    roomRouteCode = undefined;
  });
}
