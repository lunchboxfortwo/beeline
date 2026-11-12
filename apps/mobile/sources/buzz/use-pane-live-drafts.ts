import { useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { LiveOverlay } from '@beeline/buzz-client';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeClientReset } from '@/sync/client-reset';
import { liveDraftRowId } from './draft-settle';
import { applyLiveOverlayStructure } from './live-draft-drain';
import { RoomPresentationContext } from './room-presentation-context';

/**
 * A conversation shown beside the open Room (the desktop corner pane) is on
 * screen just as a routed transcript is. Tell the server so, as the routed
 * Room does, so the agent streams its draft here; and keep the draft lanes
 * that stream delivers, in the same store the transcript rows read.
 */
export function usePaneLiveDrafts(roomId: string | undefined): readonly LiveOverlay[] {
  const store = useContext(RoomPresentationContext);
  const [overlays, setOverlays] = useState<readonly LiveOverlay[]>([]);
  useEffect(() => {
    setOverlays([]);
    if (!roomId) return;
    const connection = sharedLiveConnection();
    let releaseView: (() => void) | undefined;
    const updateViewing = (viewing: boolean) => {
      if (viewing) releaseView ??= connection.view(roomId);
      else {
        releaseView?.();
        releaseView = undefined;
      }
    };
    updateViewing(AppState.currentState === 'active');
    const appState = AppState.addEventListener('change', (state) => updateViewing(state === 'active'));
    const stopReset = subscribeClientReset(() => setOverlays([]));
    const apply = (overlay: LiveOverlay) =>
      setOverlays((current) => applyLiveOverlayStructure(current, overlay, store));
    let active = true;
    let stop: (() => void) | undefined;
    void connection
      .register([{ '#h': [roomId] }], (event) => {
        if (!active || !('monolithLive' in event)) return;
        const live = event.monolithLive;
        if (!('roomId' in live) || live.roomId !== roomId) return;
        if (live.type !== 'draft' && !(live.type === 'retract' && live.kind === 'draft')) return;
        apply({
          kind: 'draft',
          key: `draft:${live.agentId}:${live.turnId}`,
          stableId: liveDraftRowId(live.agentId, live.turnId),
          agentPubkey: live.agentId,
          requestId: live.turnId,
          ...(live.type === 'draft' ? { text: live.text } : {}),
          closed: live.type === 'retract',
          createdAt: Date.now() / 1000,
        });
      })
      .then((unregister) => {
        if (active) stop = unregister;
        else unregister();
      });
    return () => {
      active = false;
      stop?.();
      stopReset();
      appState.remove();
      updateViewing(false);
    };
  }, [roomId, store]);
  return overlays;
}
