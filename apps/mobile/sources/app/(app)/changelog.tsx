import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect } from 'react';
import { ScrollView, Separator, YStack } from 'tamagui';
import { router } from 'expo-router';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { layout } from '@/components/layout';
import { useLayoutClass } from '@/utils/responsive';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SafeBottom, SafeTop, T, TypedView } from '@/ui/grammar';

export default function ChangelogScreen() {
  useLatencyRouteFrame('/changelog', true, true);
    const isCompact = useLayoutClass() === 'compact';
    const entries = getChangelogEntries();

    useEffect(() => {
        const latestTitle = getLatestTitle();
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
        }
    }, []);

    if (entries.length === 0) {
        return (
            <YStack flex={1} backgroundColor="canvas">
                <SafeTop />
                <ChangelogHeader />
                <YStack flex={1} alignItems="center" justifyContent="center" padding="8">
                    <T v="body" color="secondary" textAlign="center">
                        {"No changelog entries available."}
                    </T>
                </YStack>
            </YStack>
        );
    }

    return (
        <YStack flex={1} backgroundColor="canvas">
            <SafeTop />
            <ChangelogHeader />
            <ScrollView
                flex={1}
                backgroundColor="canvas"
                showsVerticalScrollIndicator={false}
            >
                <YStack
                    paddingHorizontal="4"
                    paddingTop="4"
                    paddingBottom="8"
                    maxWidth={isCompact ? '100%' : layout.maxWidth}
                    alignSelf="center"
                    width="100%"
                >
                    {entries.map((entry, index) => (
                        <YStack key={entry.title} marginBottom="8">
                            {index > 0 ? <Separator borderColor="stroke" marginBottom="8" /> : null}
                            <T v="title" marginBottom="2">
                                {entry.title}
                            </T>
                            {entry.summary ? (
                                <T v="body" color="secondary" marginBottom="4">
                                    {entry.summary}
                                </T>
                            ) : null}
                            {entry.markdown ? (
                                <TypedView view={MonoMarkdown} v="body" color="ink" markdown={entry.markdown} />
                            ) : null}
                        </YStack>
                    ))}
                </YStack>
                <SafeBottom />
            </ScrollView>
        </YStack>
    );
}

function ChangelogHeader() {
    return (
        <PageHeader
            backAccessibilityLabel={"Back"}
            meta="RELEASE LEDGER"
            onBack={() => router.back()}
            prominent
            title={"What's New"}
        />
    );
}
