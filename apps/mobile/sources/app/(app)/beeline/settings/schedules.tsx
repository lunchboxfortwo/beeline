import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { ScrollView, YStack } from 'tamagui';
import { CornerDownRight } from 'lucide-react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { cornerShortTitle, roomTitle, type RoomScheduleView, type RoomSubscriptionView } from '@beeline/api-contract/phone';
import {
  scheduleTitle,
  scheduleTrigger,
  subscriptionTitle,
  subscriptionWhen,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Copy, Inked, SafeBottom, SafeTop, ScreenHeader, T, Section, Row, Glyph } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Ionicons' clock in the shape Inked colours. */
function TimeOutline(props: { color?: string; size?: number }) {
  return <Ionicons name="time-outline" {...props} />;
}

type WorkEntry =
  | { kind: 'schedule'; value: RoomScheduleView }
  | { kind: 'subscription'; value: RoomSubscriptionView };

/** Timers by next run across all call sites, then event triggers. */
export function orderScheduledWork(
  schedules: readonly RoomScheduleView[],
  subscriptions: readonly RoomSubscriptionView[],
): WorkEntry[] {
  return [
    ...schedules.map((value): WorkEntry => ({ kind: 'schedule', value })),
    ...subscriptions.map((value): WorkEntry => ({ kind: 'subscription', value })),
  ].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'schedule' ? -1 : 1;
    if (a.kind === 'schedule' && b.kind === 'schedule') return a.value.nextRunAt - b.value.nextRunAt;
    return 0;
  });
}

/**
 * Everything that wakes the Room's agents without a human tag: timers and
 * subscriptions. Agents set both up. Timers order by next run before subscriptions.
 * Each row names the work, trigger, agent and call site, and opens its detail page.
 */
export default function ScheduledWork() {
  useLatencyRouteFrame('/beeline/settings/schedules');
  const desktopPageLayout = useDesktopPageLayout();
  const params = useLocalSearchParams<{
    roomId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const roomId = first(params.roomId);
  const workspaceId = first(params.workspaceId);
  const { work, loading, error } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/schedules', !loading, true);
  const schedules = work?.schedules ?? [];
  const subscriptions = work?.subscriptions ?? [];
  const entries = orderScheduledWork(schedules, subscriptions);

  const openSchedule = (schedule: RoomScheduleView) =>
    router.push({ pathname: '/beeline/settings/schedule', params: { roomId: roomId!, scheduleId: schedule.id } });

  const renderEntry = (entry: WorkEntry, index: number) => {
    const value = entry.value;
    const agent = work?.agentNames.get(value.agentId) ?? 'Agent';
    const title = entry.kind === 'schedule' ? scheduleTitle(entry.value) : subscriptionTitle(entry.value);
    const trigger = entry.kind === 'schedule' ? scheduleTrigger({ ...entry.value, paused: false })
      : subscriptionWhen({ ...entry.value, paused: false }, work?.isDirectMessage);
    const where = value.corner ? cornerShortTitle(work?.roomName, value.corner.name, value.corner.id) : 'this chat';
    return <Row key={value.id} label={title}
      leading={value.corner ? <Glyph icon={CornerDownRight} size={18} /> : undefined}
      detail={`${value.paused ? 'Paused · ' : ''}${trigger}\n@${agent} · ${where}`}
      last={index === entries.length - 1}
      onPress={() => entry.kind === 'schedule' ? openSchedule(entry.value) : router.push({
        pathname: '/beeline/settings/subscription', params: { roomId: roomId!, subscriptionId: value.id },
      })}
      testID={entry.kind === 'schedule' ? `scheduled-work-${value.id}` : `subscription-${value.id}`} />;
  };

  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.list : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <ScreenHeader title="Routines" back={() => router.back()} backLabel={work?.isDirectMessage ? 'Back to DM' : 'Back to chat'} />
      {error && <SettingsRow title={error}
          />}
      {loading ? (
        <YStack padding="8" alignItems="center" justifyContent="center">
          <SurfaceGlyphLoader testID="schedules-loader" />
        </YStack>
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          testID="scheduled-work-list"
        >
          {entries.length === 0 ? (
            <YStack padding="8" alignItems="flex-start" justifyContent="center" testID="scheduled-work-empty">
              <Inked color="needsYou" glyph={TimeOutline} size={22} />
              <T v="heading" marginTop="2">Nothing wakes agents here yet</T>
              <Copy small quiet marginTop="2">
                Agents set up routines. Ask an agent in {work?.isDirectMessage ? 'this DM' : 'this chat'} to add one.
              </Copy>
            </YStack>
          ) : (
            <YStack padding="4" gap="4">
              <Section title={work?.isDirectMessage ? 'DM' : roomTitle(work?.roomName) ?? 'Chat'}>
                {entries.map(renderEntry)}
              </Section>
            </YStack>
          )}
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      )}
    </YStack>
  );
}
