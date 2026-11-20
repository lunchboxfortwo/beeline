import { useEffect, useState } from 'react';
import { isWorkspaceListView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId, saveActiveCommunityId, watchActiveCommunityId } from '@/buzz/community-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { subscribeClientReset } from '@/sync/client-reset';
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
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (cancelled) return;
      if (!identity) {
        setWorkspaceId(null);
        return;
      }
      const stored = await loadActiveCommunityId(identity.publicKey);
      if (stored) {
        if (!cancelled) setWorkspaceId(stored);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      if (cancelled) return;
      const address = surfaceAddress(relayUrl, identity.publicKey, '/workspaces');
      const cached = mobileSurfaceCache.peek(address, isWorkspaceListView)
        ?? await mobileSurfaceCache.read(address, isWorkspaceListView);
      const list = cached ?? await mobileSurfaceCache.fetch(address, isWorkspaceListView, () =>
        new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces());
      const next = list?.workspaces[0]?.id ?? null;
      if (cancelled) return;
      const current = await loadActiveCommunityId(identity.publicKey);
      if (current) {
        setWorkspaceId(current);
        return;
      }
      if (next) await saveActiveCommunityId(identity.publicKey, next);
      if (!cancelled) setWorkspaceId(next);
    })().catch(() => {
      if (!cancelled) setWorkspaceId(null);
    });
    return () => { cancelled = true; };
  }, [enabled]);
  return enabled ? workspaceId : undefined;
}
