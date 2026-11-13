import { appErrorCopy } from '@/buzz/app-error-copy';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import React, { useCallback, useState } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { workflowDisplayName } from '@/buzz/workflow-graph';
import { workflowStarterLine } from '@/buzz/workflow-run-copy';
import { PageHeader } from '@/components/buzz/PageHeader';
import { DetailSection } from '@/components/buzz/ScheduledWorkDetail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkflowRunLine } from '@/components/buzz/WorkflowRunLine';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { SafeBottom, SafeTop, T } from '@/ui/grammar';

/**
 * One workflow: its steps on the run page's rail (every step pending, as no
 * run is open here) and its runs, reached from a run's "All runs" link or
 * from scheduled work. The trigger's facts and Stop action stay on its page.
 */
export default function Workflow() {
  useLatencyRouteFrame('/beeline/workflow');
  const params = useLocalSearchParams<{
    roomId: string;
    name: string;
  }>();
  const roomId = Array.isArray(params.roomId) ? params.roomId[0] : params.roomId;
  const name = Array.isArray(params.name) ? params.name[0] : params.name;
  const desktopPageLayout = useDesktopPageLayout();
  const [detail, setDetail] = useState<
    PhoneOperationMap['readWorkflowDefinition']['output'] | null
  >(null);
  useLatencyRouteFrame('/beeline/workflow', detail !== null, true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setDetail(await monolithPhoneOperation('readWorkflowDefinition', { roomId, name }));
      setError(null);
    } catch (caught) {
      setError(appErrorCopy(caught));
    }
  }, [roomId, name]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return (
    <YStack
      flex={1}
      backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined}
      maxWidth={desktopPageLayout ? desktopColumnWidths.detail : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}
    >
      <SafeTop />
      <PageHeader
        title={workflowDisplayName(name)}
        onBack={() => router.back()}
        backAccessibilityLabel="Back"
        testID="workflow-header"
      />
      {error ? (
        <SettingsRow title={error} />
      ) : null}
      {!detail && !error ? <SurfaceGlyphLoader /> : null}
      {detail ? (
        <ScrollView flex={1}>
          <T v="body" color="secondary" padding="4">
            {detail.contract.summary ?? detail.contract.description}
          </T>
          <DetailSection testID="workflow-steps-header" title="Steps" />
          <WorkflowRunLine
            detail={{ contract: detail.contract, roleHolders: {} }}
            now={0}
            onOpenCorner={() => undefined}
            testID="workflow-steps"
          />
          <RoomListSectionHeader title="History" />
          {detail.runs.map((run) => (
            <YStack
              key={run.runId}
              accessibilityRole="button"
              padding="4"
              gap="1"
              borderTopWidth={1}
              borderTopColor="stroke"
              onPress={() =>
                router.push(workflowRunHref(run))
              }
            >
              <T v="heading">
                {run.status === 'live' ? 'Running' : run.status === 'done' ? 'Completed' : run.status === 'abandoned' ? 'Abandoned' : 'Failed'}
              </T>
              <T v="meta" color="secondary">{workflowStarterLine(run)}</T>
              <T v="code" color="secondary" userSelect="text">
                {run.runId}
              </T>
            </YStack>
          ))}
          {!detail.runs.length ? <T v="body" color="secondary" padding="4">No runs yet.</T> : null}
          <YStack paddingBottom="6" />
          <SafeBottom />
        </ScrollView>
      ) : null}
    </YStack>
  );
}
