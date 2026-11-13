import { RoutineBody } from '@/ui/screens/profiles/RoutineBody';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useLocalSearchParams } from 'expo-router';
import { stopSchedule, useScheduledWork } from '@/buzz/scheduled-work';
import {
  StopScheduledWork,
} from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Copy, SafeBottom, SafeTop, ScreenHeader } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One schedule, with the same detail grammar as a subscription.
 */
export default function PromptSchedule() {
  useLatencyRouteFrame('/beeline/settings/schedule');
  const desktopPageLayout = useDesktopPageLayout();
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
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.detail : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <ScreenHeader title="Routine" back={() => router.back()} backLabel="Back to Routines" />
      {stopFailed ? (
        <SettingsRow
          title="Could not stop this schedule."
          action="Retry"
          onPress={() => void stop()}
          testID="schedule-stop-error"
        />
      ) : error ? (
        <SettingsRow title={error}
          />
      ) : null}
      {loading && !work ? (
        <YStack padding="8" alignItems="center" justifyContent="center">
          <SurfaceGlyphLoader testID="schedule-loader" />
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
