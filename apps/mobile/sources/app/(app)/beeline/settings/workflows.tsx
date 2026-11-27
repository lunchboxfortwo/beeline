import { PageLoader } from '@/ui/PageLoader';
import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import {
  roomTitle,
  type RoomWorkflowListResult,
  type RoomWorkflowView,
} from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { Button } from '@/components/buzz/Button';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { Copy, Row, Screen, Section } from '@/ui/grammar';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LAST_RUN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function conclusionLabel(conclusion: string | null | undefined): string {
  if (!conclusion) return 'Running';
  if (conclusion === 'success') return 'Passed';
  if (conclusion === 'failure') return 'Failed';
  return conclusion[0]!.toUpperCase() + conclusion.slice(1);
}

/** Repository workflows remain a Room-manager action; this route is only an entry surface. */
export default function RoomWorkflows() {
  useLatencyRouteFrame('/beeline/settings/workflows');
  const params = useLocalSearchParams<{ roomId?: string | string[] }>();
  const roomId = first(params.roomId);
  const [roomName, setRoomName] = useState('Chat');
  const [list, setList] = useState<RoomWorkflowListResult | null>(null);
  const [loading, setLoading] = useState(true);
  useLatencyRouteFrame('/beeline/settings/workflows', !loading, true);
  const [running, setRunning] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    workflow: RoomWorkflowView;
    message: string;
  } | null>(null);

  const reload = useCallback(async () => {
    if (!roomId) {
      setReadError('Workflow target is missing.');
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
      setReadError(null);
    } catch (caught) {
      setReadError(appReadErrorCopy(caught));
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
      setActionError(null);
      try {
        await monolithPhoneOperation('dispatchRoomWorkflow', {
          roomId,
          workflowName: workflow.name,
        });
        await reload();
      } catch (caught) {
        setActionError({
          workflow,
          message: appErrorCopy(caught, `Could not run ${workflow.name}.`),
        });
      } finally {
        setRunning(null);
      }
    },
    [list, reload, roomId, running],
  );

  const retrySend = () => {
    if (actionError) void run(actionError.workflow);
  };

  return (
    <Screen
      title="Workflows"
      eyebrow={roomTitle(roomName) ?? 'Chat'}
      back={() => router.back()}
      backLabel="Back to chat"
      headerTestID="workflows-room"
    >
      {loading ? (
        <PageLoader testID="workflows-loader" />
      ) : (
        <>
          {list?.workflows.length ? (
            <Section
              title="Dispatchable"
              note={`Branch: ${list.defaultBranch}`}
              testID="workflows-section"
            >
              {list.workflows.map((workflow, index) => {
                const busy = running === workflow.name;
                const lastRun = workflow.lastRunAt
                  ? `${LAST_RUN.format(new Date(workflow.lastRunAt * 1_000))} · ${conclusionLabel(workflow.conclusion)}`
                  : 'Never run';
                return (
                  <Row
                    key={workflow.name}
                    label={workflow.name}
                    detail={lastRun}
                    detailTone={workflow.conclusion === 'failure' ? 'removed' : undefined}
                    last={index === list.workflows.length - 1}
                    right={
                      <Button
                        accessibilityLabel={`Run ${workflow.name}`}
                        compact
                        disabled={Boolean(running)}
                        label={busy ? 'Running…' : 'Run'}
                        loading={busy}
                        onPress={() => void run(workflow)}
                        testID={`room-workflow-${workflow.name}`}
                        variant="secondary"
                      />
                    }
                  />
                );
              })}
            </Section>
          ) : !readError ? (
            <Copy small quiet>No dispatchable workflows in this chat.</Copy>
          ) : null}
          {actionError ? (
            <ErrorBanner
              inline
              onRetry={retrySend}
              testID="workflows-error"
              title={actionError.message}
            />
          ) : readError ? (
            <ErrorBanner inline testID="workflows-error" title={readError} />
          ) : null}
        </>
      )}
    </Screen>
  );
}
