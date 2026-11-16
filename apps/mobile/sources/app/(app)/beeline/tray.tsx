import { PageLoader } from '@/ui/PageLoader';
import { sendWorkReply } from '@/buzz/work-board-reply';
import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { YStack } from 'tamagui';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { navigateToRoom, messageJumpHref } from '@/buzz/corner-navigation';
import { useIsDesktop } from '@/utils/responsive';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { useWorkBoard, useWorkBoardUnavailable, loadWorkBoard } from '@/buzz/work-board-store';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Btn, Copy, T } from '@/ui/grammar';
import { TabHeader, TabRail, useScrolledUnder } from '@/ui/shell/TabHeader';
import { TAB_ROUTES } from '@/ui/shell/tab-routes';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { WorkBoard, type WorkBoardActions } from '@/ui/screens/tags/WorkBoard';
function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default function TrayScreen() {
  useLatencyRouteFrame('/beeline/tray');
  const router = useRouter();
  const desktop = useIsDesktop();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    workspaceName?: string | string[];
  }>();
  const active = useActiveCommunityId();
  const workspaceId = first(params.communityId) || active || '';
  const board = useWorkBoard(workspaceId);
  const unavailable = useWorkBoardUnavailable(workspaceId);
  const noWorkspace = unavailable || (!workspaceId && active === null);
  useLatencyRouteFrame('/beeline/tray', Boolean(board), true);
  const [error, setError] = useState<string | null>(null);
  const execute = useCallback(
    async (work: () => Promise<void>) => {
      setError(null);
      try {
        await work();
        await loadWorkBoard(workspaceId);
      } catch (cause) {
        setError(appErrorCopy(cause));
        return false;
      }
      return true;
    },
    [workspaceId],
  );
  const actions = useMemo<WorkBoardActions>(
    () => ({
      open: (item) => {
        if(item.source) {
          if(item.source.messageId) {
            const responseId=`work-source:${item.id}`;
            prefetchPushRoom(responseId,item.source.roomId);
            router.push(messageJumpHref(item.source.roomId,item.source.messageId,responseId,workspaceId));
          } else navigateToRoom(router,item.source.roomId);
          return;
        }
        if (item.messageId) {
          const responseId = `work:${item.messageId}`;
          prefetchPushRoom(responseId, item.roomId);
          router.push(messageJumpHref(item.roomId, item.messageId, responseId, workspaceId));
        } else navigateToRoom(router, item.roomId);
      },
      reply: async (item, text) => {
        setError(null);
        const author = board?.people.find((person) => person.pubkey === board.viewerId);
        if (!author) return false;
        try {
          return await sendWorkReply(item, text, author);
        } catch (cause) {
          setError(appErrorCopy(cause));
          return false;
        }
      },
      clear: (item) =>
        execute(async () => {
          await Promise.all(
            (item.askIds ?? [item.id]).map((messageId) =>
              monolithPhoneOperation('clearNeedsYou', { workspaceId, messageId }),
            ),
          );
        }),
      clearAll: () =>
        execute(async () => {
          await monolithPhoneOperation('clearNeedsYouSection', { workspaceId });
        }),
      assign: (item, assigneeId) =>
        execute(async () => {
          await monolithPhoneOperation('updateWorkItem', {
            id: item.id,
            roomId: item.roomId,
            assigneeId,
          });
        }),
      decide: (item, action) =>
        execute(async () => {
          switch (action.kind) {
            case 'choice':
              await monolithPhoneOperation('answerChoice', {
                choiceId: action.choiceId,
                optionId: action.optionId,
              });
              break;
            case 'grant':
              await monolithPhoneOperation('decideAgentGrant', {
                grantId: action.grantId,
                decision: action.decision,
              });
              break;
            case 'write-access':
              await monolithPhoneOperation('decideWritePermission', {
                roomId: item.roomId,
                permissionId: action.permissionId,
                requestId: action.requestId,
                agentId: action.agentId,
                repository: action.repository,
                decision: action.decision,
              });
              break;
            case 'external':
              await openExternalUrl(action.url);
              break;
          }
        }),
    }),
    [board, execute, router, workspaceId],
  );
  const { scrolled } = useScrolledUnder();
  const screen = (
    <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="tags-screen">
      {desktop || board ? null : (
        <TabHeader
          workspaceName={first(params.workspaceName) || WORKSPACE_LABEL}
          scrolled={scrolled}
        />
      )}
      {error ? (
        <YStack paddingHorizontal="4" paddingTop="2">
          <Copy small quiet testID="tray-error">
            {error}
          </Copy>
        </YStack>
      ) : null}
      {noWorkspace ? (
        <YStack padding="6" gap="2" alignItems="center" testID="tray-no-workspace">
          <T v="heading">No Workspace to show</T>
          <T v="meta" color="secondary">
            {unavailable
              ? 'You are no longer a member of this Workspace.'
              : 'This link did not name a Workspace, and none is open.'}
          </T>
          <Btn
            kind="secondary"
            label="Go to Chats"
            onPress={() => router.replace(TAB_ROUTES.chats as never)}
          >
            Go to Chats
          </Btn>
        </YStack>
      ) : board ? (
        <WorkBoard key={workspaceId} board={board} desktop={desktop} actions={actions} />
      ) : (
        <PageLoader />
      )}
    </YStack>
  );
  return desktop ? (
    screen
  ) : (
    <TabRail tab="tags" workspaceId={workspaceId || null}>
      {screen}
    </TabRail>
  );
}
