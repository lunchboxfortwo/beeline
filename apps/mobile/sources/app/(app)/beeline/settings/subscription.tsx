import { RoutineBody } from '@/ui/screens/profiles/RoutineBody';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import {
  stopSubscription,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Copy, SafeBottom, SafeTop, ScreenHeader } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The event and source that wake one agent, with the same stop control as a schedule. */
export default function Subscription() {
  useLatencyRouteFrame('/beeline/settings/subscription');
  const desktopPageLayout = useDesktopPageLayout();
  const params = useLocalSearchParams<{ roomId?: string | string[]; subscriptionId?: string | string[] }>();
  const roomId = first(params.roomId);
  const subscriptionId = first(params.subscriptionId);
  const { work, loading, error, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/subscription', !loading, true);
  const [working, setWorking] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const subscription = work?.subscriptions.find((candidate) => candidate.id === subscriptionId);

  const stop = async () => {
    if (!roomId || !subscription) return;
    setWorking(true);
    setStopFailed(false);
    try {
      // Already gone on the server: the page shows it stopped and rereads the list.
      if ((await stopSubscription(roomId, subscription.id)) === 'already-stopped') retry();
      else router.back();
    } catch {
      setStopFailed(true);
    } finally {
      setWorking(false);
    }
  };

  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.detail : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <ScreenHeader title="Routine" back={() => router.back()} backLabel="Back to Routines" />
      {stopFailed ? (
        <SettingsRow
          title="Could not stop this subscription."
          action="Retry"
          onPress={() => void stop()}
          testID="subscription-stop-error"
        />
      ) : error ? (
        <SettingsRow title={error}
          />
      ) : null}
      {loading && !work ? (
        <YStack padding="8" alignItems="center" justifyContent="center"><SurfaceGlyphLoader testID="subscription-loader" /></YStack>
      ) : subscription ? (
        <ScrollView testID="subscription-page">
          <RoutineBody kind="subscription" routine={subscription} work={work!} stop={<StopScheduledWork
            label="Stop subscription" onStop={() => void stop()} testID="stop-subscription" working={working} />} />
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      ) : work ? (
        <Copy small quiet padding="4" testID="subscription-gone">This subscription has stopped.</Copy>
      ) : null}
    </YStack>
  );
}
