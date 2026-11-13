import React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Separator, Tabs, XStack, YStack } from 'tamagui';
import { AtSign, Hash, Settings, Users } from 'lucide-react-native';
import { CountPill, Glyph, HEIGHT, SafeBottom, T } from '@/ui/grammar';

import { TAB_ROUTES, type Tab } from './tab-routes';

const TABS: { value: Tab; label: string; icon: typeof Hash }[] = [
    { value: 'chats', label: 'Chats', icon: Hash },
    { value: 'tags', label: 'Tags', icon: AtSign },
    { value: 'people', label: 'People', icon: Users },
    { value: 'settings', label: 'Settings', icon: Settings },
];

// Phone text sizes can wrap "People" to "Peopl" + a hidden "e"; native keeps one line and shrinks to fit.
// Web has no shrink-to-fit (it would cut the label with an ellipsis), and its labels fit already.
const ONE_LINE = Platform.OS === 'web' ? {} : { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5 };

/** The phone's four places. Chats leads; Tags carries the live count. */
export const TabBar = React.memo(function TabBar({ active, tagsCount = 0 }: { active: Tab; tagsCount?: number }) {
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
                            <XStack gap="1" alignItems="center" position="relative">
                                {/* A short line over the selected tab's icon. */}
                                {active === tab.value ? (
                                    <YStack position="absolute" top={-10} left="50%" marginLeft={-10} width={20} height={2} borderRadius={1} backgroundColor="tabOn" testID="tab-selected-line" />
                                ) : null}
                                <Glyph icon={tab.icon} color={active === tab.value ? 'tabOn' : 'tabOff'} />
                                {tab.value === 'tags' && tagsCount ? <CountPill n={tagsCount} /> : null}
                            </XStack>
                            <T v={active === tab.value ? 'metaStrong' : 'meta'} color={active === tab.value ? 'tabOn' : 'tabOff'} {...ONE_LINE}>{tab.label}</T>
                        </Tabs.Tab>
                    ))}
                </Tabs.List>
            </Tabs>
            <SafeBottom />
        </>
    );
});
