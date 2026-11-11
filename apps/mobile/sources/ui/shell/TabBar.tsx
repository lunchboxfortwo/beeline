import React from 'react';
import { router } from 'expo-router';
import { Separator, Tabs, XStack } from 'tamagui';
import { AtSign, MessagesSquare, Settings, Users } from 'lucide-react-native';
import { CountPill, Glyph, HEIGHT, SafeBottom, T } from '@/ui/grammar';

import { TAB_ROUTES, type Tab } from './tab-routes';

const TABS: { value: Tab; label: string; icon: typeof MessagesSquare }[] = [
    { value: 'chats', label: 'Chats', icon: MessagesSquare },
    { value: 'tags', label: 'Tags', icon: AtSign },
    { value: 'people', label: 'People', icon: Users },
    { value: 'settings', label: 'Settings', icon: Settings },
];

/** The phone's four places. Chats leads; Tags carries the live count. */
export function TabBar({ active, tagsCount = 0 }: { active: Tab; tagsCount?: number }) {
    // A tab press returns to that place's root, not on top of a pushed page.
    const go = (tab: string) => {
        if (router.canDismiss()) router.dismissAll();
        router.replace(TAB_ROUTES[tab as Tab] as never);
    };
    return (
        <>
            <Separator borderColor="stroke" />
            <Tabs value={active} onValueChange={go} flexShrink={0} testID="tab-bar">
                <Tabs.List justifyContent="space-around" paddingVertical="2" backgroundColor="canvas">
                    {TABS.map((tab) => (
                        <Tabs.Tab key={tab.value} value={tab.value} flex={1} minHeight={HEIGHT.tabBar} flexDirection="column" gap="1" backgroundColor="canvas" aria-label={tab.label} testID={`tab-${tab.value}`}>
                            <XStack gap="1" alignItems="center">
                                <Glyph icon={tab.icon} accent={active === tab.value} />
                                {tab.value === 'tags' && tagsCount ? <CountPill n={tagsCount} /> : null}
                            </XStack>
                            <T v="meta" color={active === tab.value ? 'needsYou' : 'secondary'}>{tab.label}</T>
                        </Tabs.Tab>
                    ))}
                </Tabs.List>
            </Tabs>
            <SafeBottom />
        </>
    );
}
