import { useEffect, useState, useSyncExternalStore } from 'react';
import { isWorkspaceListView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId, saveActiveCommunityId, watchActiveCommunityId } from '@/buzz/community-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { RoomViewClient } from '@/sync/transport/room-view-client';

/** Current Workspace for the signed-in viewer; `undefined` until the first value is known. */
export function useActiveCommunityId(retryGeneration = 0): string | null | undefined {
  const [communityId, setCommunityId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    let attempt = 0;
    // An identity or relay change follows the new viewer's current Workspace.
    const follow = () => {
      stop?.();
      stop = undefined;
      setCommunityId(undefined);
      const current = ++attempt;
      void loadBuzzIdentity()
        .catch(() => null)
        .then((identity) => {
          if (cancelled || current !== attempt) return;
          if (!identity) return setCommunityId(null);
          stop = watchActiveCommunityId(identity.publicKey, setCommunityId);
        });
    };
    follow();
    const stopReset = subscribeClientReset(follow);
    return () => {
      cancelled = true;
      stopReset();
      stop?.();
    };
  }, [retryGeneration]);
  return communityId;
}

/**
 * The chat list's unsaved fallback: the first Workspace the viewer belongs to.
 * `undefined` while that read is open; `null` when the viewer has none.
 * A resolved id is stored so Tasks and Team share it with the chat list.
 */
export function useFallbackWorkspaceId(enabled: boolean): string | null | undefined {
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(undefined);
  const focused = useSurfaceFocus();
  const reset = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
  useEffect(() => {
    if (!enabled || !focused) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    setWorkspaceId(undefined);
    void (async () => {
      const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
      if (cancelled) return;
      if (!identity) {
        setWorkspaceId(null);
        return;
      }
      const address = surfaceAddress(relayUrl, identity.publicKey, '/workspaces');
      let reading = false;
      let pending = false;
      const read = async () => {
        if (cancelled) return;
        pending = true;
        if (reading) return;
        reading = true;
        pending = false;
        let requested = false;
        try {
          const list = await mobileSurfaceCache.fetch(address, isWorkspaceListView, () => {
            requested = true;
            return new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces();
          });
          if (cancelled || pending || !requested || !list) return;
          const current = await loadActiveCommunityId(identity.publicKey);
          if (cancelled || pending) return;
          const next = current || list.workspaces[0]?.id || null;
          if (next && !current) await saveActiveCommunityId(identity.publicKey, next);
          if (!cancelled) setWorkspaceId(next);
        } catch { return; } finally {
          reading = false;
          if ((pending || !requested) && !cancelled) void read();
        }
      };
      const release = await sharedLiveConnection().register([], (event) => {
        if (invalidatesWorkspaceList(event)) void read();
      });
      if (cancelled) { release(); return; }
      stop = release;
      await read();
    })().catch(() => undefined);
    return () => { cancelled = true; stop?.(); };
  }, [enabled, focused, reset]);
  return enabled ? workspaceId : undefined;
}
