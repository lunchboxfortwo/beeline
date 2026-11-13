import React, { useCallback, useEffect, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { router, type Href } from 'expo-router';
import { Separator } from 'tamagui';
import { isWorkspaceListView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { BuzzCommunityShell, useCommunityDrawer, type CommunityRailItem } from '@/components/buzz/CommunityRail';
import { SafeTop } from '@/ui/grammar';
import { ChatListHeader } from '@/ui/screens/chats/ChatListHeader';
import { TAB_ROUTES, type Tab } from './tab-routes';

/** Whether content has scrolled under a tab's header, and the scroll props that track it. */
export function useScrolledUnder() {
    const [scrolled, setScrolled] = useState(false);
    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setScrolled(event.nativeEvent.contentOffset.y > 0);
    }, []);
    return { scrolled, scrollProps: { onScroll, scrollEventThrottle: 16 } };
}

/**
 * The fixed header every phone tab shares: the Workspace name opens the
 * Workspace rail, then that tab's own buttons. No line at rest; a hairline
 * once content scrolls under it.
 */
export function TabHeader({ scrolled, ...header }: Omit<React.ComponentProps<typeof ChatListHeader>, 'onWorkspace'> & { scrolled: boolean }) {
    const drawer = useCommunityDrawer();
    return (
        <>
            <SafeTop />
            <ChatListHeader {...header} onWorkspace={drawer?.openDrawer} />
            <Separator borderColor={scrolled ? 'stroke' : 'transparent'} testID="tab-header-edge" />
        </>
    );
}

/**
 * The Workspace rail for Tags, People and Settings (Chats carries its own).
 * Choosing a Workspace makes it current and reopens the same tab on it.
 */
export function TabRail({ tab, workspaceId, children }: {
    tab: Exclude<Tab, 'chats'>; workspaceId?: string | null; children: React.ReactNode;
}) {
    const [viewer, setViewer] = useState<string | null>(null);
    const [communities, setCommunities] = useState<CommunityRailItem[]>([]);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
            if (!identity || cancelled) return;
            setViewer(identity.publicKey);
            const list = await mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView);
            if (!cancelled && list) setCommunities(list.workspaces.map(workspaceRailItem));
        })().catch(() => undefined);
        return () => { cancelled = true; };
    }, []);
    const select = useCallback((id: string | null) => {
        if (!id) return;
        if (viewer) void saveActiveCommunityId(viewer, id);
        router.replace({ pathname: TAB_ROUTES[tab], params: tab === 'settings' ? { workspaceId: id } : { communityId: id } } as never);
    }, [tab, viewer]);
    return (
        <BuzzCommunityShell communities={communities} activeCommunityId={workspaceId ?? null} onSelect={select}
            onAdd={() => router.push('/beeline/community' as Href)}>
            {children}
        </BuzzCommunityShell>
    );
}
