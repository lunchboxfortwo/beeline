// PEOPLE-1 proof: the real TabBar (this branch) beside main's TabBar, in the
// real Tamagui themes and fonts, at text scales 1, 1.2 (Medium, Large), 1.5 and 1.8.
// Tap the header to switch Bone/Obsidian. On web, ?theme=obsidian and ?side=pr work too.
// Same as the app entry: Tamagui pressables need React Native's internal usePressability on native.
import '../../sources/polyfills/usePressability';
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as Fonts from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { TamaguiProvider, Theme, YStack } from 'tamagui';
import { TextScaleContext } from '@/ui/grammar';
import { tamaguiConfig, themeName } from '@/ui/tamagui.config';
import { TabBar } from '@/ui/shell/TabBar';
import { TabBarMain } from './TabBar.main';

const SCALES = [1, 1.2, 1.5, 1.8];
const query = Platform.OS === 'web' ? new URLSearchParams(globalThis.location?.search ?? '') : new URLSearchParams();

function Row({ scale, side }: { scale: number; side: 'main' | 'pr' }) {
    const Bar = side === 'main' ? TabBarMain : TabBar;
    return (
        <TextScaleContext.Provider value={scale}>
            <Text testID={`label-${side}-${scale}`} style={{ fontSize: 11, color: '#888', paddingHorizontal: 8, paddingTop: 6 }} allowFontScaling={false}>{side} · scale {scale}</Text>
            <View testID={`bar-${side}-${scale}`}><Bar active="people" tagsCount={3} /></View>
        </TextScaleContext.Provider>
    );
}

function Root() {
    const [ready, setReady] = useState(false);
    const [dark, setDark] = useState(query.get('theme') === 'obsidian');
    const only = query.get('side') as 'main' | 'pr' | null;
    useEffect(() => {
        Fonts.loadAsync({
            'IBMPlexMono-Regular': require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
            'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
            'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
            'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
        }).then(() => setReady(true));
    }, []);
    if (!ready) return null;
    const name = themeName(dark ? 'dark' : 'light', 'brass');
    return (
        <SafeAreaProvider>
            <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
                <Theme name={name}>
                    <YStack flex={1} backgroundColor="canvas">
                        <Pressable testID="toggle-theme" onPress={() => setDark((d) => !d)} style={{ padding: 8, paddingTop: 32 }}>
                            <Text allowFontScaling={false} style={{ color: '#888', fontSize: 12 }}>PEOPLE-1 · {dark ? 'Obsidian' : 'Bone'} (tap to switch)</Text>
                        </Pressable>
                        <ScrollView>
                            {SCALES.map((scale) => (
                                <View key={scale}>
                                    {only !== 'pr' ? <Row scale={scale} side="main" /> : null}
                                    {only !== 'main' ? <Row scale={scale} side="pr" /> : null}
                                </View>
                            ))}
                        </ScrollView>
                    </YStack>
                </Theme>
            </TamaguiProvider>
        </SafeAreaProvider>
    );
}

registerRootComponent(Root);
