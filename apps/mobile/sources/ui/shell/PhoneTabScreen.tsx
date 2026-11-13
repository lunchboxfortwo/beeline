import React from 'react';
import { YStack } from 'tamagui';
import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { TabBar } from './TabBar';
import { tabForPath, type Tab } from './tab-routes';

/**
 * A phone stack screen with its own tab bar under it, when its route draws
 * one (the stack's `screenLayout`). Every place except a chat or thread (their
 * composer owns the keyboard edge), viewers, the shared browser and setup.
 *
 * Each screen carries its own bar, so pushing a chat never resizes the stack:
 * a bar shared under the stack disappeared only after the chat's first frame,
 * and the composer started one bar height too high, then dropped.
 */
export function PhoneTabScreen({ route, children }: { route: { name: string }; children: React.ReactElement }) {
    const active = tabForPath(`/${route.name}`);
    if (!active) return children;
    return (
        <YStack flex={1}>
            {children}
            <PhoneTabBar active={active} />
        </YStack>
    );
}

function PhoneTabBar({ active }: { active: Tab }) {
    const workspaceId = useActiveCommunityId() ?? undefined;
    const tagsCount = useNeedsYouCount(workspaceId, workspaceId);
    return <TabBar active={active} tagsCount={tagsCount} />;
}
