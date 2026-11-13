import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isWorkspaceView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import {
    recordWorkspacePage, useWorkspaceRecords, workspacePage, workspaceRecordScope, workspaceRows,
} from '@/buzz/workspace-records';
import { watchWorkspace } from '@/buzz/workspace-watch';
import { RoomViewClient } from '@/sync/transport/room-view-client';

type Member = WorkspaceView['members'][number];
type Agent = WorkspaceView['agents'][number];

/**
 * The workspace roster (`readWorkspace`, then `readWorkspaceMembers` for
 * further pages): the one shared registry entry, painted from cache and read
 * again on open and on every live roster change of this workspace.
 */
export function useWorkspaceRoster(workspaceId: string | null | undefined) {
    const focused = useSurfaceFocus();
    const focusedRef = useRef(focused);
    focusedRef.current = focused;
    const [viewer, setViewer] = useState<{ identity: Identity; relayUrl: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(([identity, relayUrl]) => {
            if (!cancelled && identity) setViewer({ identity, relayUrl });
        });
        return () => { cancelled = true; };
    }, []);

    const address = useMemo(() => viewer && workspaceId
        ? surfaceAddress(viewer.relayUrl, viewer.identity.publicKey, '/workspace/:id', { workspaceId })
        : null, [viewer, workspaceId]);
    const scope = viewer && workspaceId ? workspaceRecordScope(viewer.relayUrl, viewer.identity.publicKey, workspaceId) : null;
    const surface = useSurfaceSnapshot(address, isWorkspaceView);
    const version = useWorkspaceRecords(scope);

    useEffect(() => {
        if (!focused || !viewer || !workspaceId || !address) return;
        let cancelled = false;
        const http = new RoomViewClient({ baseUrl: viewer.relayUrl, identity: viewer.identity });
        const read = async () => {
            if (cancelled || !focusedRef.current) return;
            try {
                await mobileSurfaceCache.fetch(address, isWorkspaceView, () => http.workspace(workspaceId));
                if (!cancelled) setError(null);
            } catch (reason) {
                if (!cancelled) setError(appReadErrorCopy(reason));
            }
        };
        void mobileSurfaceCache.read(address, isWorkspaceView).catch(() => undefined);
        const watch = watchWorkspace(viewer.identity, viewer.relayUrl, workspaceId, () => void read(),
            (reason) => { if (!cancelled) setError(appReadErrorCopy(reason)); });
        void watch.ready.then(read, () => undefined);
        return () => { cancelled = true; watch.release(); };
    }, [focused, viewer, workspaceId, address]);

    const page = useMemo(() => workspacePage(scope, ''), [scope, version]);
    const people = useMemo(() => workspaceRows<Member>(scope, page.people?.ids ?? []), [scope, page, version]);
    const agents = useMemo(() => workspaceRows<Agent>(scope, page.agents?.ids ?? []), [scope, page, version]);

    /** The next page of one kind, appended to the shared roster. */
    const loadMore = useCallback(async (kind: 'human' | 'agent') => {
        if (!viewer || !workspaceId || !scope || loadingMore) return;
        setLoadingMore(true);
        try {
            const stamp = currentSurfaceStamp();
            const offset = kind === 'human' ? page.people?.ids.length ?? 0 : page.agents?.ids.length ?? 0;
            const next = await new RoomViewClient({ baseUrl: viewer.relayUrl, identity: viewer.identity })
                .workspaceMembers(workspaceId, { kind, offset });
            recordWorkspacePage(scope, next, { query: '', kind, append: true, stamp });
        } catch (reason) {
            setError(appErrorCopy(reason, ''));
        } finally {
            setLoadingMore(false);
        }
    }, [viewer, workspaceId, scope, page, loadingMore]);

    return {
        surface,
        scope,
        viewerPubkey: viewer?.identity.publicKey,
        people,
        agents,
        peopleTotal: page.people?.total ?? surface?.peopleTotal ?? people.length,
        agentTotal: page.agents?.total ?? surface?.agentTotal ?? agents.length,
        morePeople: Boolean(page.people?.truncated),
        moreAgents: Boolean(page.agents?.truncated),
        loadMore,
        loadingMore,
        error,
    };
}
