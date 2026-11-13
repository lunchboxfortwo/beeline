import { isRoomView, type RoomView, type SurfaceCacheAddress } from '@beeline/buzz-client';
import { subscribePhoneLiveEvents } from '@/sync/transport/phone-live-events';
import { identityScope } from './identity-records';
import { writeRoomMessage, writeRoomTurn } from './room-message-records';
import type { SurfaceRegistry } from './surface-registry';

type Viewer = { relayUrl: string; viewerPubkey: string };
type Cache = Pick<SurfaceRegistry, 'peek' | 'publish' | 'persist'>;

/** One committed-frame owner, before deck/Room observers. It survives route
 * changes and backgrounding; neither screen maintains a second transcript. */
export function observeRoomLiveState(cache: Cache, viewer: () => Viewer | null): () => void {
  return subscribePhoneLiveEvents(event => {
    const current = viewer();
    if (!current || !('roomId' in event) || !event.roomId) return;
    const address = { relayOrigin: current.relayUrl, viewerPubkey: current.viewerPubkey,
      endpoint: `/room/${event.roomId}` };
    const scope = identityScope(current.relayUrl, current.viewerPubkey);
    if (event.type === 'turn-delta') {
      writeRoomTurn(scope, event.roomId, event.turn);
      const room = cache.peek(address, isRoomView);
      if (room) void cache.persist(address, room, isRoomView).catch(() => undefined);
      return;
    }
    if (event.type === 'message-delta' || event.type === 'sidebar-preview') {
      const message = event.type === 'sidebar-preview' ? event.preview
        : event.version === undefined ? event.message : { ...event.message, version: event.version };
      writeRoomMessage(scope, event.roomId, message, event.type === 'message-delta');
      if (event.deckPreview) writeRoomMessage(scope, event.roomId,
        { ...event.deckPreview, presentation: event.deckPreview.presentation ?? 'message' }, event.deckPreview.presentation !== undefined);
      const room = cache.peek(address, isRoomView);
      if (room) void cache.persist(address, room, isRoomView).catch(() => undefined);
      return;
    }
    if (event.type !== 'read-state' && event.type !== 'room-commands') return;
    // Read cursor and command queue are response metadata, not message stores.
    const room = cache.peek(address, isRoomView);
    if (!room) return;
    const next: RoomView = event.type === 'read-state'
      ? { ...room, viewer: { ...room.viewer, readCursor: event.readCursor } }
      : { ...room, pendingAgentCommands: event.commands };
    cache.publish(address, next, isRoomView);
    void cache.persist(address, next, isRoomView).catch(() => undefined);
  });
}
