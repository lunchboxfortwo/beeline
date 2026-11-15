import React, { createContext, useContext } from 'react';
import { YStack } from 'tamagui';
import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { TabBar } from './TabBar';
import { isTabRootPath, tabForPath, type Tab } from './tab-routes';

/** The height of the one tab bar the shell keeps mounted over the four tab roots; null without that shell. */
export const SharedTabBarHeight = createContext<number | null>(null);

/**
 * A phone stack screen and the tab bar its route draws. The four tab roots
 * share the shell's bar, so switching tabs changes only the page; a root
 * reserves the bar's height. Any other place draws its own bar, and a chat or
 * thread none (their composer owns the keyboard edge), viewers, the shared
 * browser and setup. A bar in flow under the stack disappeared only after a
 * pushed chat's first frame, and the composer started one bar height too
 * high, then dropped; the shared bar sits over the stack and never resizes it.
 */
export function PhoneTabScreen({ route, children }: { route: { name: string }; children: React.ReactElement }) {
    const shared = useContext(SharedTabBarHeight);
    const path = `/${route.name}`;
    const active = tabForPath(path);
    if (!active) return children;
    return (
        <YStack flex={1}>
            {children}
            {shared !== null && isTabRootPath(path) ? <YStack height={shared} /> : <PhoneTabBar active={active} />}
        </YStack>
    );
}

export function PhoneTabBar({ active }: { active: Tab }) {
    const workspaceId = useActiveCommunityId() ?? undefined;
    const tagsCount = useNeedsYouCount(workspaceId, workspaceId);
    return <TabBar active={active} tagsCount={tagsCount} />;
}
