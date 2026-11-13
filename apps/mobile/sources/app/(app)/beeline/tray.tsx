import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, FlatList } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { YStack } from 'tamagui';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import type { AttachmentReference } from '@beeline/buzz-client';
import { isWorkspaceListView, isWorkspaceView } from '@beeline/buzz-client';
import { appErrorCopy, appReadErrorCopy } from '@/buzz/app-error-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { messageJumpHref } from '@/buzz/corner-navigation';
import { useIsDesktop } from '@/utils/responsive';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import {
  useTrayList,
  forgetTray,
  acknowledgePaintedNeedsYou,
  loadNeedsYouList,
  loadTrayList,
  removeNeedsYou,
  subscribeTrayGap,
} from '@/buzz/needs-you-store';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { openArtifactViewer } from '@/components/buzz/ArtifactCard';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { openExternalUrl } from '@/utils/open-external-url';
import { Btn, Copy, T } from '@/ui/grammar';
import { TAB_ROUTES } from '@/ui/shell/tab-routes';
import { TabHeader, TabRail, useScrolledUnder } from '@/ui/shell/TabHeader';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { TagCard, type TagCardActions } from '@/ui/screens/tags/TagCard';
import type { TagDecision } from '@/ui/screens/tags/tag-card-model';

const EMPTY_NEEDS: readonly NeedsYouItemView[] = [];

/** The server's refusal once the person has left, or been removed from, the Workspace. */
function lostWorkspace(reason: unknown): boolean {
  return (reason as { code?: unknown } | null)?.code === 'workspace membership required';
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** "Nothing needs you", one line, and the way back to Chats. */
function TagsEmpty({ onChats }: { onChats: () => void }) {
  return (
    <YStack paddingTop="8" paddingHorizontal="4" gap="3" alignItems="center" testID="needs-you-empty">
      <T v="heading" textAlign="center">Nothing needs you</T>
      <T v="meta" color="secondary" textAlign="center">
        Approvals, decisions and messages that tag you appear here as they arrive.
      </T>
      <Btn kind="secondary" label="Go to Chats" marginTop="2" onPress={onChats}>Go to Chats</Btn>
    </YStack>
  );
}

/**
 * Tags: the server's live Needs-you projection for this Workspace as cards.
 * Approving, deciding or reading a tag re-reads that projection; a live
 * `needs-you-delta` moves the cards and the count together. Opening an
 * approval never decides or dismisses it.
 */
export default function TrayScreen() {
  useLatencyRouteFrame('/beeline/tray');
  const router = useRouter();
  const desktop = useIsDesktop();
  const params = useLocalSearchParams<{ communityId?: string | string[]; workspaceName?: string | string[] }>();
  const routeWorkspaceId = first(params.communityId);
  // A link without a Workspace id opens the Workspace the Chats list treats
  // as active. `undefined` while resolving; `null` when there is none.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null | undefined>(undefined);
  const currentWorkspaceId = useActiveCommunityId();
  const workspaceId = routeWorkspaceId || activeWorkspaceId || '';
  // A Workspace the person is no longer a member of: its items open nothing.
  const [lostWorkspaceId, setLostWorkspaceId] = useState<string | null>(null);
  const lostWorkspaceRef = useRef<string | null>(null);
  const workspaceLost = Boolean(workspaceId) && lostWorkspaceId === workspaceId;
  const noWorkspace = (!routeWorkspaceId && activeWorkspaceId === null) || workspaceLost;
  const { needs } = useTrayList(workspaceId);
  const [loading, setLoading] = useState(true);
  const loadedWorkspaceRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  useLatencyRouteFrame('/beeline/tray', !loading, true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(first(params.workspaceName) || null);
  const focused = useRef(false);
  const paintContext = useRef({ workspaceId, ready: false });
  paintContext.current = { workspaceId, ready: !loading && !noWorkspace };
  const viewableQuestions = useRef<readonly string[]>([]);
  const paintFrame = useRef<number | null>(null);

  // markSeen: only questions this focused screen actually painted start their clock.
  const acknowledgePaint = useCallback(() => {
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    const context = paintContext.current;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      if (!focused.current || AppState.currentState !== 'active' || !context.ready || !paintContext.current.ready ||
        context.workspaceId !== paintContext.current.workspaceId) return;
      void acknowledgePaintedNeedsYou(context.workspaceId, viewableQuestions.current).catch(() => undefined);
    });
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    acknowledgePaint();
    return () => {
      focused.current = false;
      viewableQuestions.current = [];
      if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    };
  }, [acknowledgePaint]));
  const onViewableItemsChanged = useRef(({ viewableItems }: {
    viewableItems: readonly { item: NeedsYouItemView; isViewable?: boolean }[];
  }) => {
    viewableQuestions.current = viewableItems.flatMap(({ item, isViewable }) =>
      isViewable !== false && !item.approval && item.expiresAt === undefined ? [item.messageId] : []);
    acknowledgePaint();
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;

  const load = useCallback(async (force = false) => {
    if (!workspaceId) return;
    const generation = ++loadGenerationRef.current;
    setError(null);
    const result = await Promise.allSettled([loadTrayList(workspaceId, force)]).then(([answer]) => answer);
    if (generation !== loadGenerationRef.current) return;
    if (result.status === 'rejected' && (lostWorkspace(result.reason) || lostWorkspaceRef.current === workspaceId)) {
      lostWorkspaceRef.current = workspaceId;
      setLostWorkspaceId(workspaceId);
      forgetTray(workspaceId);
      setLoading(false);
      loadedWorkspaceRef.current = null;
      return;
    }
    lostWorkspaceRef.current = null;
    setLostWorkspaceId(null);
    if (result.status === 'rejected') setError(appReadErrorCopy(result.reason));
    else if (result.value.needsError) setError(result.value.needsError);
    if (result.status === 'fulfilled') loadedWorkspaceRef.current = workspaceId;
    setLoading(false);
  }, [workspaceId]);

  // The previous account's cards and lost Workspace do not carry over.
  useEffect(() => subscribeClientReset(() => {
    loadGenerationRef.current += 1;
    loadedWorkspaceRef.current = null;
    lostWorkspaceRef.current = null;
    setLostWorkspaceId(null);
    void load();
  }), [load]);

  // A socket gap asks for one covering read; nothing polls.
  useEffect(() => (workspaceId ? subscribeTrayGap(workspaceId, (reason) => {
    if (reason === 'needs-you-gap') void loadNeedsYouList(workspaceId).catch(() => load(true));
    else if (reason !== 'bookmark-gap') void load(true);
  }) : undefined), [workspaceId, load]);

  // A held projection paints immediately; a new Workspace reads once.
  useFocusEffect(useCallback(() => {
    if (loadedWorkspaceRef.current !== workspaceId) void load();
    return undefined;
  }, [load, workspaceId]));

  useEffect(() => {
    if (routeWorkspaceId || currentWorkspaceId === undefined) return;
    let cancelled = false;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) {
        if (!cancelled) setActiveWorkspaceId(null);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const list = await mobileSurfaceCache.read(
        surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView);
      if (cancelled) return;
      setActiveWorkspaceId(
        list?.workspaces.some((workspace) => workspace.id === currentWorkspaceId)
          ? currentWorkspaceId
          : (list?.workspaces[0]?.id ?? currentWorkspaceId),
      );
    })().catch(() => {
      if (!cancelled) setActiveWorkspaceId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, routeWorkspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
      if (!identity || cancelled) return;
      const [list, workspace] = await Promise.all([
        mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView),
        mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', { workspaceId }), isWorkspaceView),
      ]);
      if (!cancelled) setWorkspaceName(first(params.workspaceName) ||
        (list?.workspaces.find((item) => item.id === workspaceId)?.name ?? workspace?.workspace.name ?? null));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, params.workspaceName]);

  /** Reading a tag (or dismissing a merge ask) leaves this Tags, and every other device's. */
  const clear = useCallback(async (item: NeedsYouItemView, dismissReminder = false) => {
    const removal = removeNeedsYou(item.workspaceId, [item.messageId]);
    try {
      const input = { workspaceId: item.workspaceId, messageId: item.messageId, ...(dismissReminder ? { dismissReminder: true } : {}) };
      await monolithPhoneOperation('clearNeedsYou', input);
      removal.settle();
    } catch (cause) {
      // A failure that lands after an account switch belongs to the previous account.
      if (removal.restore()) setError(appErrorCopy(cause));
    }
  }, []);

  const actions = useMemo((): TagCardActions => ({
    open: (item) => {
      // Opening an approval does not dismiss or decide it; opening a tag reads it.
      if (!item.approval) void clear(item);
      const responseId = `needs-you:${item.messageId}`;
      // Start the read now, as a push tap does; the chat takes it by this id.
      prefetchPushRoom(responseId, item.roomId);
      router.push(messageJumpHref(item.roomId, item.messageId, responseId, item.workspaceId));
    },
    openImage: (item: NeedsYouItemView, image: AttachmentReference) => openArtifactViewer(image, desktop, item.roomId),
    decide: async (item: NeedsYouItemView, decision: TagDecision) => {
      const generation = clientResetGeneration();
      setError(null);
      try {
        if (decision.kind === 'dismiss') {
          AccessibilityInfo.announceForAccessibility('Dismissed from Tags');
          await clear(item, true);
          return;
        }
        if (decision.kind === 'merge') {
          await monolithPhoneOperation('approveCornerMerge', { cornerId: item.roomId });
        } else {
          const action = decision.action;
          switch (action.kind) {
            case 'grant':
              await monolithPhoneOperation('decideAgentGrant', { grantId: action.grantId, decision: action.decision });
              break;
            case 'write-access':
              await monolithPhoneOperation('decideWritePermission', { roomId: item.roomId,
                permissionId: action.permissionId, requestId: action.requestId, agentId: action.agentId,
                repository: action.repository, decision: action.decision });
              break;
            case 'choice':
              await monolithPhoneOperation('answerChoice', { choiceId: action.choiceId, optionId: action.optionId });
              break;
            case 'skip-choice':
              await monolithPhoneOperation('skipChoice', { choiceId: action.choiceId });
              break;
            case 'external':
              // Trusty Squire decides on its own passkey page; the card stays until it does.
              await openExternalUrl(action.url);
              return;
          }
        }
        if (generation !== clientResetGeneration()) return;
        // The server's projection removes a decided card; there is no local removal.
        await loadNeedsYouList(item.workspaceId);
        AccessibilityInfo.announceForAccessibility('Decision sent');
      } catch (cause) {
        if (generation === clientResetGeneration()) setError(appErrorCopy(cause));
      }
    },
  }), [clear, desktop, router]);

  const items = loading || workspaceLost ? EMPTY_NEEDS : (needs ?? EMPTY_NEEDS);
  const decisions = useMemo(() => items.filter(item => item.approval || item.addressedReport), [items]);
  const tags = useMemo(() => items.filter(item => !item.approval && !item.addressedReport), [items]);
  const groupedItems = useMemo(() => [...decisions, ...tags], [decisions, tags]);
  // Ages are read when the projection changes, so unchanged cards do not re-render.
  const now = useMemo(() => Date.now(), [items]);
  const goToChats = useCallback(() => router.replace(TAB_ROUTES.chats as never), [router]);
  const { scrolled, scrollProps } = useScrolledUnder();

  const list = (
    <FlatList
      data={groupedItems}
      keyExtractor={(item) => item.messageId}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      renderItem={({ item, index }) => (
        <YStack paddingHorizontal="3" paddingTop="3">
          {index === 0 && decisions.length > 0 ? (
            <RoomListSectionHeader title="Decisions" count={decisions.length} inset="content" spacing="flush" testID="tray-decisions-heading" />
          ) : index === decisions.length ? (
            <RoomListSectionHeader title="Tags" count={tags.length} inset="content" spacing="flush" testID="tray-tags-heading" />
          ) : null}
          <TagCard item={item} now={now} actions={actions} />
        </YStack>
      )}
      ListFooterComponent={<YStack height={12} />}
      ListEmptyComponent={
        noWorkspace ? (
          <YStack padding="6" gap="2" alignItems="center" testID="tray-no-workspace">
            <T v="heading" textAlign="center">No Workspace to show</T>
            <T v="meta" color="secondary" textAlign="center">
              {workspaceLost
                ? 'You are no longer a member of this Workspace.'
                : 'This link did not name a Workspace, and none is open.'}
            </T>
            <Btn kind="secondary" label="Go to Chats" onPress={goToChats}>Go to Chats</Btn>
          </YStack>
        ) : loading ? (
          <YStack padding="6" alignItems="center" testID="tray-loader">
            <SurfaceGlyphLoader />
          </YStack>
        ) : (
          <TagsEmpty onChats={goToChats} />
        )
      }
      testID="tray-list"
      {...scrollProps}
    />
  );

  const screen = (
    <YStack flex={1} minHeight={0} backgroundColor="canvas" testID="tags-screen">
      {/* The header every tab shares; Tags has no buttons of its own. */}
      {desktop ? null : <TabHeader workspaceName={workspaceName ?? WORKSPACE_LABEL} scrolled={scrolled} />}
      {error ? <YStack paddingHorizontal="4" paddingTop="2"><Copy small quiet testID="tray-error">{error}</Copy></YStack> : null}
      <YStack flex={1} minHeight={0} width="100%" maxWidth={desktop ? 760 : undefined} alignSelf="center">
        {list}
      </YStack>
    </YStack>
  );
  return desktop ? screen : <TabRail tab="tags" workspaceId={workspaceId || null}>{screen}</TabRail>;
}
