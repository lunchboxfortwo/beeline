import { PageLoader } from '@/ui/PageLoader';
import { RoutineBody } from '@/ui/screens/profiles/RoutineBody';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import {
  stopSubscription,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { Copy, SafeBottom, SafeTop, ScreenHeader } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The event and source that wake one agent, with the same stop control as a schedule. */
export default function Subscription() {
  useLatencyRouteFrame('/beeline/settings/subscription');
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
    <YStack flex={1} backgroundColor="canvas" width="100%" maxWidth={720} alignSelf="center">
      <SafeTop />
      <ScreenHeader title="Routine" back={() => router.back()} backLabel="Back to Routines" />
      {stopFailed ? (
        <YStack paddingHorizontal="4" paddingTop="3">
          <ErrorBanner
            inline
            title="Could not stop this subscription."
            onRetry={() => void stop()}
            testID="subscription-stop-error"
          />
        </YStack>
      ) : error ? (
        <YStack paddingHorizontal="4" paddingTop="3">
          <ErrorBanner inline title={error} />
        </YStack>
      ) : null}
      {loading && !work ? (
        <PageLoader testID="subscription-loader" />
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
