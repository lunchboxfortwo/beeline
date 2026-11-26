import { PageLoader } from '@/ui/PageLoader';
import { RoutineBody } from '@/ui/screens/profiles/RoutineBody';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { stopSchedule, useScheduledWork } from '@/buzz/scheduled-work';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { StopScheduledWork } from '@/components/buzz/ScheduledWorkDetail';
import { Copy, SafeBottom, SafeTop, ScreenHeader } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One schedule, with the same detail grammar as a subscription.
 */
export default function PromptSchedule() {
  useLatencyRouteFrame('/beeline/settings/schedule');
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    scheduleId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const scheduleId = first(params.scheduleId);
  const { work, loading, error, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/schedule', !loading, true);
  const [working, setWorking] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const schedule = work?.schedules.find((candidate) => candidate.id === scheduleId);

  const stop = async () => {
    if (!roomId || !schedule) return;
    setWorking(true);
    setStopFailed(false);
    try {
      // Already gone on the server: the page shows it stopped and rereads the list.
      if ((await stopSchedule(roomId, schedule.id)) === 'already-stopped') retry();
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
            title="Could not stop this schedule."
            onRetry={() => void stop()}
            testID="schedule-stop-error"
          />
        </YStack>
      ) : error ? (
        <YStack paddingHorizontal="4" paddingTop="3">
          <ErrorBanner inline title={error} />
        </YStack>
      ) : null}
      {loading && !work ? (
        <YStack padding="8" alignItems="center" justifyContent="center">
          <PageLoader testID="schedule-loader" />
        </YStack>
      ) : schedule ? (
        <ScrollView testID="schedule-page">
          <RoutineBody kind="schedule" routine={schedule} work={work!} stop={<StopScheduledWork
            label="Stop schedule" onStop={() => void stop()} testID="stop-schedule" working={working} />} />
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      ) : work ? (
        <Copy small quiet padding="4" testID="schedule-gone">
          This schedule has stopped.
        </Copy>
      ) : null}
    </YStack>
  );
}
