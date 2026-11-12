import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React from 'react';
import { ScrollView, YStack } from 'tamagui';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { cornerShortTitle, roomTitle, type RoomScheduleView, type RoomSubscriptionView } from '@beeline/api-contract/phone';
import {
  scheduleTitle,
  scheduleTrigger,
  subscriptionTitle,
  subscriptionWhen,
  scheduleWhere,
  useScheduledWork,
} from '@/buzz/scheduled-work';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ScheduledWorkWhere } from '@/components/buzz/ScheduledWorkWhere';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Copy, Inked, SafeBottom, SafeTop, T } from '@/ui/grammar';

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

function ListAttribution({ agent, corner, roomName, isDirectMessage }: {
  isDirectMessage?: boolean;
  roomName?: string | null;
  agent: string;
  corner?: { id: string; name: string } | null;
}) {
  return <>
    <Copy small quiet numberOfLines={1} minWidth={0}>@{agent}</Copy>
    <Copy small quiet flexShrink={0}>{' · '}</Copy>
    <ScheduledWorkWhere isDirectMessage={isDirectMessage} corner={corner ? { ...corner, name: cornerShortTitle(roomName, corner.name, corner.id) } : undefined} />
  </>;
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
  const { work, loading, error, retry } = useScheduledWork(roomId);
  useLatencyRouteFrame('/beeline/settings/schedules', !loading, true);
  const schedules = work?.schedules ?? [];
  const subscriptions = work?.subscriptions ?? [];
  const entries = orderScheduledWork(schedules, subscriptions);

  const openSchedule = (schedule: RoomScheduleView) =>
    router.push({ pathname: '/beeline/settings/schedule', params: { roomId: roomId!, scheduleId: schedule.id } });

  const renderSchedule = (schedule: RoomScheduleView) => (
    <SettingsRow
      chevron="right"
      description={scheduleTrigger(schedule)}
      descriptionContent={<Copy small quiet numberOfLines={1}>{scheduleTrigger(schedule)}</Copy>}
      descriptionDetail={`@${work?.agentNames.get(schedule.agentId) ?? 'Agent'} · ${scheduleWhere(schedule, work?.roomName, work?.isDirectMessage)}`}
      descriptionDetailContent={<ListAttribution
        isDirectMessage={work?.isDirectMessage} roomName={work?.roomName} agent={work?.agentNames.get(schedule.agentId) ?? 'Agent'} corner={schedule.corner} />}
      key={schedule.id}
      onPress={() => openSchedule(schedule)}
      testID={`scheduled-work-${schedule.id}`}
      title={scheduleTitle(schedule)}
    />
  );

  const renderSubscription = (subscription: RoomSubscriptionView) => (
    <SettingsRow
      chevron="right"
      description={subscriptionWhen(subscription, work?.isDirectMessage)}
      descriptionContent={<Copy small quiet numberOfLines={1}>{subscriptionWhen(subscription, work?.isDirectMessage)}</Copy>}
      descriptionDetail={`@${work?.agentNames.get(subscription.agentId) ?? 'Agent'} · ${scheduleWhere(subscription, work?.roomName, work?.isDirectMessage)}`}
      descriptionDetailContent={<ListAttribution
        isDirectMessage={work?.isDirectMessage} roomName={work?.roomName} agent={work?.agentNames.get(subscription.agentId) ?? 'Agent'} corner={subscription.corner} />}
      key={subscription.id}
      onPress={() =>
        router.push({
          pathname: '/beeline/settings/subscription',
          params: { roomId: roomId!, subscriptionId: subscription.id },
        })
      }
      testID={`subscription-${subscription.id}`}
      title={subscriptionTitle(subscription)}
    />
  );

  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.list : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <PageHeader
        backAccessibilityLabel={work?.isDirectMessage ? 'Back to DM' : 'Back to chat'}
        eyebrow={work?.isDirectMessage ? 'DM' : roomTitle(work?.roomName) ?? 'Chat'}
        onBack={() => router.back()}
        testID="scheduled-work-header"
        title="Schedules and subscriptions"
      />
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
                Agents set up schedules and subscriptions. Ask an agent in {work?.isDirectMessage ? 'this DM' : 'this chat'} to add one.
              </Copy>
            </YStack>
          ) : (
            // SettingsRow pads by 8; keep the flat list on the 16pt page axis.
            <YStack paddingHorizontal="2">{entries.map((entry) => entry.kind === 'schedule'
            ? renderSchedule(entry.value) : renderSubscription(entry.value))}</YStack>
          )}
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      )}
    </YStack>
  );
}
