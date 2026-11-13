import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isRoomView, type Identity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { appReadErrorCopy } from '@/buzz/app-error-copy';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { RoomViewClient } from '@/sync/transport/room-view-client';

/** Durable changes to who is in a Room, or to the Room itself. */
const ROOM_CHANGES = new Set(['postgres:memberships', 'postgres:rooms']);

/**
 * The chat's own `readRoom` answer (the registry entry the open chat paints),
 * for Members and Chat info. It paints the held answer at once; a cold open
 * (deep link, desktop panel) reads it, and a membership or Room change on the
 * live socket reads it again. `refresh` follows this screen's own writes.
 */
export function useRoomView(roomId: string | undefined) {
    const [viewer, setViewer] = useState<{ identity: Identity; relayUrl: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(([identity, relayUrl]) => {
            if (!cancelled && identity) setViewer({ identity, relayUrl });
        });
        return () => { cancelled = true; };
    }, []);
    const address = useMemo(() => viewer && roomId
        ? surfaceAddress(viewer.relayUrl, viewer.identity.publicKey, `/room/${roomId}`)
        : null, [viewer, roomId]);
    const room = useSurfaceSnapshot(address, isRoomView);
    const addressRef = useRef(address);
    addressRef.current = address;

    const refresh = useCallback(async () => {
        const current = addressRef.current;
        if (!current || !viewer || !roomId) return;
        try {
            await mobileSurfaceCache.fetch(current, isRoomView,
                () => new RoomViewClient({ baseUrl: viewer.relayUrl, identity: viewer.identity }).room(roomId));
            setError(null);
        } catch (reason) {
            setError(appReadErrorCopy(reason));
        }
    }, [viewer, roomId]);

    useEffect(() => {
        if (!address || !roomId) return;
        let cancelled = false;
        void mobileSurfaceCache.read(address, isRoomView)
            .then((held) => { if (!cancelled && !held) void refresh(); })
            .catch(() => { if (!cancelled) void refresh(); });
        let stop: (() => void) | undefined;
        void sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
            if (cancelled || !('monolithLive' in event)) return;
            const live = event.monolithLive;
            if (live.type !== 'invalidate') return;
            if ((live.roomId === roomId && ROOM_CHANGES.has(live.reason)) || (live.roomId === '' && live.reason === 'reconnect'))
                void refresh();
        }).then((unregister) => { if (cancelled) unregister(); else stop = unregister; }, () => undefined);
        return () => { cancelled = true; stop?.(); };
    }, [address, roomId, refresh]);

    return { room, viewerPubkey: viewer?.identity.publicKey, error, refresh };
}
