import React from 'react';
import { BackHandler, Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import { YStack } from 'tamagui';
import type { MobileMinimum, StorePlatform } from '@beeline/api-contract/mobile-minimum';
import { fetchStoreUpdate, hourlyStoreUpdateCheck, STORE_LISTINGS } from '@/buzz/store-update';
import { subscribeUpdateConnections } from '@/buzz/update-connections';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { Button } from '@/components/buzz/Button';
import { BeelineGlyphPaint } from '@/components/buzz/BeelineGlyphPaint';
import { GrowScroll, SafeBottom, SafeTop, T } from '@/ui/grammar';

const checkStoreUpdate = hourlyStoreUpdateCheck(() =>
  fetchStoreUpdate(getBuzzRuntimeConfig().monolithUrl, Platform.OS, Application.nativeApplicationVersion));

export function StoreUpdateScreen({ minimum, installed, platform }: {
  minimum: MobileMinimum; installed: string; platform: StorePlatform;
}) {
  return (
    <YStack flex={1} backgroundColor="canvas" testID="store-update-required">
      <SafeTop />
      <GrowScroll flex={1}>
        <YStack flexGrow={1} padding="6">
          <YStack flexGrow={1} width="100%" maxWidth={400} alignSelf="center">
            <YStack paddingTop="6" paddingBottom="8">
              <BeelineGlyphPaint size={44} framing="cell" loop="once" live={false} />
            </YStack>
            <YStack flexGrow={1} />
            <YStack gap="2">
              <T v="title" accessibilityRole="header">Update Beeline to keep going</T>
              <T v="body" color="secondary">{minimum.reason}</T>
              <T v="code" color="secondary" marginTop="2">{installed} → {minimum.minVersion}</T>
              <Button fullWidth destination="external" label={platform === 'android' ? 'Update on Google Play' : 'Update on the App Store'}
                marginTop="4"
                onPress={() => { void Linking.openURL(STORE_LISTINGS[platform]).catch(() => {}); }} />
            </YStack>
          </YStack>
        </YStack>
      </GrowScroll>
      <SafeBottom />
    </YStack>
  );
}

/** Root replacement keeps sign-in, deep links and Android Back behind the gate. */
export function StoreUpdateGate({ children, fontsReady = true, active = true }: { children: React.ReactNode; fontsReady?: boolean; active?: boolean }) {
  const [minimum, setMinimum] = React.useState<MobileMinimum | null>(null);
  const initialCheck = React.useRef(false);
  const lastConnection = React.useRef(-1);
  React.useEffect(() => {
    if (!active || Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    let mounted = true;
    let generation = 0;
    const check = () => {
      const current = ++generation;
      void checkStoreUpdate()
        .then(result => { if (mounted && current === generation) setMinimum(result); });
    };
    if (!initialCheck.current) { initialCheck.current = true; check(); }
    const stop = subscribeUpdateConnections(epoch => {
      if (epoch <= lastConnection.current) return;
      lastConnection.current = epoch; check();
    });
    return () => { mounted = false; stop(); };
  }, [active]);
  React.useEffect(() => {
    if (!minimum || Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [minimum]);
  return fontsReady && minimum && (Platform.OS === 'android' || Platform.OS === 'ios')
    ? <StoreUpdateScreen minimum={minimum} installed={Application.nativeApplicationVersion!} platform={Platform.OS} />
    : <>{children}</>;
}
