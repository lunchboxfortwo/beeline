import { PageLoader } from '@/ui/PageLoader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { observeRoomResource, useObservedResource } from '@/buzz/use-observed-resource';
import {
  identityHandle,
  type WorkflowRunDetailView,
  type WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref, messageJumpHref } from '@/buzz/corner-navigation';
import { useRoomLiveDrafts } from '@/buzz/room-live-drafts';
import { liveRoomRuns, useRoomWorkflowRuns } from '@/buzz/use-room-workflow-run';
import { workflowDisplayName, workflowStateLabel } from '@/buzz/workflow-graph';
import { formatRunDuration, runDayLabel, workflowRunHeadline, workflowRunHref, workflowStarterLine } from '@/buzz/workflow-run-copy';
import { HullLivePulse } from '@/components/buzz/MonoHull';
import { PageHeader } from '@/components/buzz/PageHeader';
import {
  WorkflowRunLine,
  WorkflowStepCircle,
} from '@/components/buzz/WorkflowRunLine';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Btn, Copy, SafeBottom, SafeTop, T } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const LIVE_DOT = 10;
const LIVE_HALO = 20;

/**
 * One workflow run, read the way a GitHub Actions run reads: a status plate,
 * an optional workflow summary, then every contract step on one straight
 * rail — done, current, and upcoming (dimmed) — each with its one-line `does`
 * sentence plus the agent's live narration or final reply. The page only
 * records the run: it has no controls and no way back to the run's own
 * corner; Back returns to where the reader came from. Corners a step opened
 * are links.
 */
export default function WorkflowRun() {
  useLatencyRouteFrame('/beeline/workflow-run');
  const desktopPageLayout = useDesktopPageLayout();
  const params = useLocalSearchParams<{ roomId?: string | string[]; runId?: string | string[] }>();
  const roomId = first(params.roomId);
  const runId = first(params.runId);
  const { data: detail, loading, error, retry } = useObservedResource<WorkflowRunDetailView>(
    `workflow-run:${roomId}:${runId}`, {
      load: async () => {
        if (!roomId || !runId) throw new Error('Workflow run is missing.');
        if (!(await loadBuzzIdentity())) {
          router.replace('/beeline/onboarding' as Href);
          throw new Error('Sign in to read this workflow run.');
        }
        return monolithPhoneOperation('readWorkflowRun', { roomId, runId });
      },
      subscribe: roomId ? observeRoomResource(roomId) : undefined,
    },
  );
  useLatencyRouteFrame('/beeline/workflow-run', detail !== null, true);
  const liveDrafts = useRoomLiveDrafts(detail?.run.status === 'live' ? roomId : undefined);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));
  useEffect(() => {
    if (detail?.run.status !== 'live') return;
    setNow(Math.floor(Date.now() / 1_000));
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1_000)), 1000);
    return () => clearInterval(clock);
  }, [detail?.run.status]);

  const run = detail?.run;
  const live = run?.status === 'live';
  const last = detail?.history[detail.history.length - 1];
  const starter = detail ? workflowStarterLine(detail.run) || detail.history[0]?.actor?.name : undefined;
  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.list : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <PageHeader
        backAccessibilityLabel="Back"
        eyebrow={run?.roomName ?? 'Workflow'}
        onBack={() => router.back()}
        testID="workflow-run-header"
        title={run ? workflowDisplayName(run.workflowSlug) : 'Workflow'}

      />
      {error && <SettingsRow title={error}
          />}
      {loading && !detail ? (
        <YStack padding="8" alignItems="center" justifyContent="center">
          <PageLoader testID="workflow-run-loader" />
        </YStack>
      ) : detail && run ? (
        <ScrollView testID="workflow-run-page">
          {roomId ? (
            <Btn
              kind="quiet"
              label="All runs"
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: '/beeline/workflow', params: { roomId, name: run.workflowSlug } })
              }
              alignSelf="flex-start"
              paddingHorizontal="4"
            >
              <T v="meta" color="needsYou">All runs</T>
            </Btn>
          ) : null}
          <YStack paddingTop="6" paddingHorizontal="4" testID="workflow-run-summary">
            <XStack alignItems="center" gap="2">
              {live ? (
                <YStack width={LIVE_HALO} height={LIVE_HALO} alignItems="center" justifyContent="center">
                  <YStack position="absolute" left={0} top={0} width={LIVE_HALO} height={LIVE_HALO}>
                    <HullLivePulse>
                      <YStack width={LIVE_HALO} height={LIVE_HALO} borderRadius="full" borderWidth={1} borderColor="needsYou" />
                    </HullLivePulse>
                  </YStack>
                  <YStack width={LIVE_DOT} height={LIVE_DOT} borderRadius="full" backgroundColor="needsYou" />
                </YStack>
              ) : (
                <WorkflowStepCircle status={run.status === 'done' ? 'done' : 'failed'} />
              )}
              <T
                v="title"
                flex={1}
                color={run.viewerHolds && live ? 'needsYou' : 'ink'}
                testID="workflow-run-status"
              >
                {workflowRunHeadline(run, live ? undefined : last?.outcome)}
              </T>
            </XStack>
            <Copy small quiet marginTop="1" testID="workflow-run-started">
              {starter ? `${starter} · ` : ''}
              {`${runDayLabel(run.startedAt)} ${TIME.format(new Date(run.startedAt * 1_000))}`}
              {live ? ' · running ' : ' · took '}
              {formatRunDuration((live ? now : run.updatedAt) - run.startedAt)}
            </Copy>
          </YStack>
          {detail.contract.summary ? (
            // A rail + secondary copy, like a thread's objective.
            <XStack alignItems="flex-start" gap="2" marginHorizontal="4" marginVertical="4">
              <YStack alignSelf="stretch" width={2} backgroundColor="strongStroke" />
              <Copy small quiet flex={1} minWidth={0} testID="workflow-run-description">
                {detail.contract.summary}
              </Copy>
            </XStack>
          ) : null}
          <RoomListSectionHeader title="Steps" testID="workflow-run-steps-header" />
          <WorkflowRunLine
            detail={detail}
            liveDrafts={liveDrafts}
            now={now}
            onOpenCorner={(corner) =>
              router.push(cornerHref(corner.id, corner.parentRoomId, corner.name))
            }
            onOpenMessage={(messageId) =>
              router.push(messageJumpHref(run.roomId, messageId, `workflow-gate:${messageId}`))
            }
          />
          {roomId ? <AlsoRunning current={run} now={now} roomId={roomId} /> : null}
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      ) : null}
    </YStack>
  );
}

/**
 * Every other live saved-workflow run in the corner, any workflow — a
 * section every run page shows alike (symmetric), so a corner running
 * several workflows at once can be read, and switched between, from any one
 * of their run pages. Tapping a row replaces this page in the navigation
 * stack, so Back from any run page always returns to the corner.
 */
function AlsoRunning({ roomId, current, now }: { roomId: string; current: WorkflowRunSummaryView; now: number }) {
  // The Room's one shared workflow-run read, not a second copy of it.
  const runs = useRoomWorkflowRuns(roomId);
  const others = liveRoomRuns(roomId, runs).filter((candidate) => candidate.runId !== current.runId);
  if (others.length === 0) return null;
  return (
    <YStack testID="workflow-run-also-running">
      <XStack marginTop="2" paddingHorizontal="4" alignItems="center" justifyContent="space-between"
        borderBottomWidth={1} borderBottomColor="stroke">
        <RoomListSectionHeader title="Also running in this thread" inset="content" />
      </XStack>
      {others.map((other) => (
        <XStack
          accessibilityLabel={`Open ${workflowDisplayName(other.workflowSlug)}, ${workflowStateLabel(other.state)}`}
          accessibilityRole="link"
          key={other.runId}
          onPress={() => router.replace(workflowRunHref(other))}
          minHeight={44}
          alignItems="center"
          justifyContent="space-between"
          paddingHorizontal="4"
          paddingVertical="1"
          testID={`workflow-run-also-running-${other.runId}`}
        >
          <YStack flex={1} minWidth={0}>
            <Copy numberOfLines={1}>
              {`${workflowDisplayName(other.workflowSlug)} · ${workflowStateLabel(other.state)}`}
            </Copy>
            {other.holder ? (
              <Copy small quiet numberOfLines={1} marginTop="1">{`@${identityHandle(other.holder)}`}</Copy>
            ) : null}
          </YStack>
          <Copy small quiet marginTop="1">{formatRunDuration(now - other.startedAt)}</Copy>
        </XStack>
      ))}
    </YStack>
  );
}
