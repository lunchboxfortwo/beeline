import { isRoomView, type RoomView, type SurfaceCacheAddress } from '@beeline/buzz-client';
import type { LiveWireEvent } from '@/sync/transport/monolith-rig-transport';
import { subscribePhoneLiveEvents } from '@/sync/transport/phone-live-events';
import { identityScope } from './identity-records';
import { roomTurns, writeRoomMessage, writeRoomTurn } from './room-message-records';
import { reconcileRoomMessageDelta, reconcileRoomTurnDelta } from './room-view-presentation';
import type { SurfaceRegistry } from './surface-registry';

type RoomLiveDelta = Extract<LiveWireEvent, { type: 'message-delta' | 'turn-delta' | 'read-state' | 'room-commands' }>;

type Viewer = { relayUrl: string; viewerPubkey: string };
type Cache = Pick<SurfaceRegistry, 'peek' | 'publish' | 'read' | 'persist' | 'remove'>;

/** One committed-frame owner, before deck/Room observers. It survives route
 * changes and backgrounding; neither screen maintains a second transcript. */
export function observeRoomLiveState(cache: Cache, viewer: () => Viewer | null): () => void {
  return subscribePhoneLiveEvents(event => {
    const current = viewer();
    if (!current || !('roomId' in event) || !event.roomId) return;
    const address = { relayOrigin: current.relayUrl, viewerPubkey: current.viewerPubkey,
      endpoint: `/room/${event.roomId}` };
    if (event.type === 'sidebar-preview') {
      // Older servers may still supply a partial frame. Never invent its body.
      void cache.remove(address).catch(() => undefined);
      return;
    }
    if (event.type !== 'message-delta' && event.type !== 'turn-delta' &&
        event.type !== 'read-state' && event.type !== 'room-commands') return;
    const scope = identityScope(current.relayUrl, current.viewerPubkey);
    if (event.type === 'turn-delta') writeRoomTurn(scope, event.roomId, event.turn);
    if (event.type === 'message-delta') writeRoomMessage(scope, event.roomId,
      event.version === undefined ? event.message : { ...event.message, version: event.version });
    applyRoomLiveDelta(cache, address, event, () => {
      const active = viewer();
      return active?.relayUrl === current.relayUrl && active.viewerPubkey === current.viewerPubkey;
    });
  });
}

/** Complete server deltas update the same authorized response a Room paints. */
function applyRoomLiveDelta(
  cache: Cache,
  address: SurfaceCacheAddress,
  event: RoomLiveDelta,
  active: () => boolean = () => true,
): void {
  const apply = () => {
    if (!active()) return true;
    const room = cache.peek(address, isRoomView);
    if (!room) return false;
    let next: RoomView;
    switch (event.type) {
      case 'message-delta':
        next = reconcileRoomMessageDelta(room, event.version === undefined
          ? event.message : { ...event.message, version: event.version });
        break;
      case 'turn-delta': {
        const turns = roomTurns(identityScope(address.relayOrigin, address.viewerPubkey), event.roomId);
        const latest = [...new Map([...room.latestAgentTurns, ...turns, event.turn]
          .map(turn => [turn.agentPubkey, turn])).values()];
        next = reconcileRoomTurnDelta(room, event.turn, latest);
        break;
      }
      case 'read-state':
        next = { ...room, viewer: { ...room.viewer, readCursor: event.readCursor } };
        break;
      case 'room-commands':
        next = { ...room, pendingAgentCommands: event.commands };
        break;
      default: return true;
    }
    if (next !== room) {
      cache.publish(address, next, isRoomView);
      void cache.persist(address, next, isRoomView).catch(() => undefined);
    }
    return true;
  };
  if (!apply()) void cache.read(address, isRoomView).then(room => { if (room) apply(); }).catch(() => undefined);
}
