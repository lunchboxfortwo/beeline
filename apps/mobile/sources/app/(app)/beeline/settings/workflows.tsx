import { PageLoader } from '@/ui/PageLoader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import {
  roomTitle,
  type RoomWorkflowListResult,
  type RoomWorkflowView,
} from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { PageHeader } from '@/components/buzz/PageHeader';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { Copy, Inked, SafeBottom, SafeTop, T } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LAST_RUN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Repository workflows remain a Room-manager action; this route is only an entry surface. */
export default function RoomWorkflows() {
  useLatencyRouteFrame('/beeline/settings/workflows');
  const desktopPageLayout = useDesktopPageLayout();
  const params = useLocalSearchParams<{ roomId?: string | string[] }>();
  const roomId = first(params.roomId);
  const [roomName, setRoomName] = useState('Chat');
  const [list, setList] = useState<RoomWorkflowListResult | null>(null);
  const [loading, setLoading] = useState(true);
  useLatencyRouteFrame('/beeline/settings/workflows', !loading, true);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId) {
      setError('Workflow target is missing.');
      setLoading(false);
      return;
    }
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) {
        router.replace('/beeline/onboarding' as Href);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const room = await new RoomViewClient({ baseUrl: relayUrl, identity }).room(roomId);
      if (!room.viewer.permissions.manage) throw new Error('Workspace admins only');
      if (room.repositoryResolution !== 'repository') throw new Error('Chat repository required');
      const workflows = await monolithPhoneOperation('listRoomWorkflows', { roomId });
      setRoomName(room.room.name);
      setList(workflows);
      setError(null);
    } catch (caught) {
      setError(appReadErrorCopy(caught));
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  const run = useCallback(
    async (workflow: RoomWorkflowView) => {
      if (!roomId || !list || running) return;
      const confirmed = await Modal.confirm(
        `Run ${workflow.name}?`,
        `Run ${workflow.name} on ${list.defaultBranch}?`,
        { cancelText: 'Cancel', confirmText: 'Run' },
      );
      if (!confirmed) return;
      setRunning(workflow.name);
      setError(null);
      try {
        await monolithPhoneOperation('dispatchRoomWorkflow', {
          roomId,
          workflowName: workflow.name,
        });
        await reload();
      } catch (caught) {
        setError(appErrorCopy(caught, `Could not run ${workflow.name}.`));
      } finally {
        setRunning(null);
      }
    },
    [list, reload, roomId, running],
  );

  return (
    <YStack flex={1} backgroundColor="canvas"
      width={desktopPageLayout ? '100%' : undefined} maxWidth={desktopPageLayout ? desktopColumnWidths.list : undefined}
      alignSelf={desktopPageLayout ? 'center' : undefined}>
      <SafeTop />
      <PageHeader
        backAccessibilityLabel="Back to chat"
        eyebrow={roomTitle(roomName) ?? 'Chat'}
        onBack={() => router.back()}
        testID="workflows-room"
        title="Workflows"
      />
      {loading ? (
        <PageLoader testID="workflows-loader" />
      ) : (
        <ScrollView>
          <YStack padding="4" gap="2">
          <Copy small quiet marginBottom="1">
            Dispatches run on {list?.defaultBranch ?? 'the repository default branch'}.
          </Copy>
          {list?.workflows.length ? (
            list.workflows.map((workflow) => {
              const busy = running === workflow.name;
              const lastRun = workflow.lastRunAt
                ? `${LAST_RUN.format(new Date(workflow.lastRunAt * 1_000))} · ${workflow.conclusion ?? 'running'}`
                : 'Never run';
              return (
                <XStack
                  accessibilityLabel={`Run ${workflow.name}`}
                  accessibilityRole="button"
                  disabled={Boolean(running)}
                  key={workflow.name}
                  onPress={running ? undefined : () => void run(workflow)}
                  minHeight={56}
                  borderTopWidth={1}
                  borderTopColor="stroke"
                  paddingVertical="2"
                  alignItems="center"
                  gap="2"
                  testID={`room-workflow-${workflow.name}`}
                >
                  <YStack flex={1} minWidth={0} gap="1">
                    <T v="heading">{workflow.name}</T>
                    <Copy small quiet>{lastRun}</Copy>
                  </YStack>
                  <XStack alignItems="center" gap="1">
                    <T v="metaStrong" color="needsYou">{busy ? 'RUNNING…' : 'RUN'}</T>
                    {!busy ? (
                      <Inked color="needsYou" glyph={ChevronGlyph} direction="right" size={CHEVRON_ROW_SIZE} />
                    ) : null}
                  </XStack>
                </XStack>
              );
            })
          ) : (
            <Copy small quiet>No dispatchable workflows in this chat.</Copy>
          )}
          {error && (
            <SettingsRow
              title={error}
              testID="workflows-error"
            />
          )}
          </YStack>
        </ScrollView>
      )}
      <SafeBottom />
    </YStack>
  );
}
