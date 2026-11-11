import React from 'react';
import { usePathname } from 'expo-router';
import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { TabBar } from './TabBar';
import { tabForPath } from './tab-routes';

/**
 * The phone's tab bar, under every place except a chat or thread (their
 * composer owns the keyboard edge), viewers, the shared browser and setup.
 */
export function PhoneTabBar() {
    const pathname = usePathname();
    const workspaceId = useActiveCommunityId() ?? undefined;
    const tagsCount = useNeedsYouCount(workspaceId, workspaceId);
    const active = tabForPath(pathname);
    if (!active) return null;
    return <TabBar active={active} tagsCount={tagsCount} />;
}
