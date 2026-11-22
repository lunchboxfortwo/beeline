import { isRoomView } from '@beeline/buzz-client';
import type { RoomView } from '@beeline/api-contract/phone';
import { peekBuzzViewerContext } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { reconcileRoomView } from '@/buzz/room-view-presentation';

/**
 * A write that already returned the Room it opened (a new thread) publishes
 * that read for the opening screen, which then paints it at mount instead of
 * reading it again. `stamp` is the surface clock from before the write.
 */
export function publishOpenedRoom(view: unknown, stamp: number): void {
  if (!isRoomView(view)) return;
  const viewer = peekBuzzViewerContext();
  const config = getBuzzRuntimeConfig();
  if (!viewer || viewer.relayUrl !== config.monolithUrl) return;
  const address = surfaceAddress(config.monolithUrl, viewer.viewerPubkey, `/room/${(view as RoomView).room.id}`);
  const published = mobileSurfaceCache.publish(address,
    reconcileRoomView(mobileSurfaceCache.peek(address, isRoomView), view), isRoomView, stamp);
  void mobileSurfaceCache.persist(address, published, isRoomView).catch(() => undefined);
}
