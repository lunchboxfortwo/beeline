import { useChannelsRouteState } from './useChannelsRouteState';
import { useChannelsPresentation } from './useChannelsPresentation';
import { useChannelsRequestedActions } from './useChannelsRequestedActions';
import { useChannelsRoomActions } from './useChannelsRoomActions';
import { useChannelsSubscriptions } from './useChannelsSubscriptions';
import { useChannelsNavigation } from './useChannelsNavigation';
import { useChannelsRepositories } from './useChannelsRepositories';
import { useChannelsCompose } from './useChannelsCompose';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { restoreStoredSurface, surfaceAddress } from '@/buzz/surface-storage';
import { watchActiveCommunityId } from '@/buzz/community-storage';
import { messageSearchHref } from '@/buzz/use-message-search';
import { roomRowName } from '@/buzz/room-list-row';
import { roomHref } from '@/buzz/corner-navigation';
import { BuzzCommunityShell, useCommunityDrawer } from '@/components/buzz/CommunityRail';
import { WorkspaceAddAgentSheet } from '@/ui/screens/members/ChatAddSheets';
import { RoomDeckLoadingView } from '@/components/buzz/RoomDeckLoadingView';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Btn, Copy, Glyph, SafeTop, T } from '@/ui/grammar';
import { ChatListHeader } from '@/ui/screens/chats/ChatListHeader';
import { ChatRow, ChatRowDivider, JoinableChats } from '@/ui/screens/chats/ChatTree';
import { MessageMatches } from '@/ui/screens/chats/MessageMatches';
import { NewChatSheet } from '@/ui/screens/chats/NewChatSheet';
import { isWorkspaceListView, type ChatListItem, type Identity } from '@beeline/buzz-client';
import { router, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { memo, useContext, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Separator, XStack, YStack } from 'tamagui';
import { LogOut } from 'lucide-react-native';
import { FirstContentDrawContext, isInitialLandingNavigationSuppressed, isInitialLandingResolved, markInitialLandingResolved } from '@/navigation/initial-landing';
import { isPersonNameOnboardingPending } from '@/buzz/person-name';
import { initialAuthUrl } from '@/auth/desktop-auth-session';
import { deliverDesktopDeepLink } from '@/auth/desktop-deep-link';
import { parseCommunityInviteToken } from '@/buzz/community-invite';
import { parseReviewSecret } from '@/buzz/review-link';
import { subscribeClientReset } from '@/sync/client-reset';

export const AGE_TICK_MS = 60_000;
const ROW_HEIGHT = 64;

/** The first Workspace view: quiet orientation, then two restrained actions. */
function EmptyRoomActions({ canAddRoom, canConnectAgent, onAddRoom, onConnectAgent, testID = 'room-list-empty' }: {
  canAddRoom: boolean;
  canConnectAgent: boolean;
  onAddRoom: () => void;
  onConnectAgent: () => void;
  testID?: string;
}) {
  return (
    <YStack padding="4" paddingTop="8" gap="2" testID={testID}>
      <T v="heading">No chats yet</T>
      <Copy small quiet>A chat holds the people and agents working on one thing.</Copy>
      <XStack gap="2" paddingTop="3">
        {canAddRoom ? <Btn kind="primary" label="New chat" onPress={onAddRoom} testID="empty-add-room">New chat</Btn> : null}
        {canConnectAgent ? <Btn label="Connect an agent" onPress={onConnectAgent} testID="empty-connect-agent">Connect an agent</Btn> : null}
      </XStack>
    </YStack>
  );
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export type DeckSession = { identity: Identity; relayUrl: string; workspaceId: string | null };

export default function SavedRoomDeck() {
  const rootRoute = useRef(usePathname() === '/').current;
  const rootLanding = useRef(rootRoute && !isInitialLandingResolved()).current;
  const requestedWorkspaceId = firstParam(useLocalSearchParams<{ communityId?: string | string[] }>().communityId);
  const notifyDraw = useContext(FirstContentDrawContext);
  const [session, setSession] = useState<DeckSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let stopWorkspace: (() => void) | undefined;
    const restore = async () => {
      stopWorkspace?.();
      setSession(null);
      setError(null);
      const [identity, relayUrl, url, naming] = await Promise.all([
        loadBuzzIdentity(),
        getEffectiveRelayUrl(),
        rootLanding ? initialAuthUrl().catch(() => null) : null,
        rootRoute ? isPersonNameOnboardingPending() : false,
      ]);
      if (cancelled) return;
      const mayRedirect = !rootLanding || !isInitialLandingNavigationSuppressed();
      if (rootLanding && url && mayRedirect) {
        if (deliverDesktopDeepLink(url, router)) return;
        const review = parseReviewSecret(url);
        const invite = parseCommunityInviteToken(url);
        if (review) {
          router.replace({ pathname: '/review/[secret]', params: { secret: review } });
          return;
        }
        if (invite) {
          router.replace({ pathname: '/join/[token]', params: { token: invite } });
          return;
        }
      }
      if (!identity || naming) {
        if (mayRedirect) router.replace('/beeline/onboarding');
        return;
      }
      stopWorkspace = watchActiveCommunityId(identity.publicKey, (workspaceId) => {
        if (cancelled) return;
        restoreStoredSurface(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView);
        // A Room saves its Workspace on arrival. The already drawn deck's
        // session does not change when that is the Workspace it is showing.
        setSession(current => current?.identity === identity &&
          current.relayUrl === relayUrl && current.workspaceId === workspaceId
          ? current : { identity, relayUrl, workspaceId });
      });
    };
    void restore().catch((reason) => {
      if (!cancelled) setError(appErrorCopy(reason));
    });
    const stopReset = subscribeClientReset(() => {
      cancelled = true;
      stopWorkspace?.();
      setSession(null);
      setRetry(value => value + 1);
    });
    return () => {
      cancelled = true;
      stopWorkspace?.();
      stopReset();
    };
  }, [rootRoute, rootLanding, retry]);
  useEffect(() => { if (session || error) markInitialLandingResolved(); }, [session, error]);
  if (error) return (
    <YStack flex={1} backgroundColor="canvas" onLayout={notifyDraw} testID="room-deck-unavailable">
      <SafeTop />
      <YStack padding="4" gap="2">
        <T v="heading">Secure storage unavailable</T>
        <Copy small quiet>{error}</Copy>
        <XStack>
          <Btn label="Retry" accessibilityHint="Secure storage unavailable" onPress={() => setRetry(value => value + 1)} testID="room-deck-error-retry">{'Retry'}</Btn>
        </XStack>
      </YStack>
    </YStack>
  );
  return session ? (
    <BuzzChannels
      key={`${session.identity.publicKey}:${session.relayUrl}:${requestedWorkspaceId ?? session.workspaceId}`}
      session={session}
    />
  ) : <RoomDeckLoadingView />;
}

/** The list header on a phone: the Workspace name opens today's Workspace drawer. */
function DeckHeader(props: Omit<React.ComponentProps<typeof ChatListHeader>, 'onWorkspace'>) {
  const drawer = useCommunityDrawer();
  return <ChatListHeader {...props} onWorkspace={drawer?.openDrawer} />;
}

const EMPTY_CHATS: readonly ChatListItem[] = [];

const BuzzChannels = memo(function BuzzChannels({ session }: { session: DeckSession }) {
  const state = useChannelsRouteState(session);
  const view = useChannelsPresentation(state);
  const { refreshMissed, refreshNow } = useChannelsRequestedActions(state, view);
  const actions = useChannelsRoomActions(state, view.rows, state.chatList?.chats ?? EMPTY_CHATS);
  useChannelsSubscriptions(state, view.activeCommunityId, refreshMissed);
  const { selectWorkspace, rowActions, openRoom, joining, join } = useChannelsNavigation(state, view, actions);
  const repositories = useChannelsRepositories(state, view, openRoom);
  const { landing, closeAgentConnect, connectAgent } = useChannelsCompose(state, view);
  const { chatList, identity, isDesktop, error, refreshing, needsYouCount, ageNow, onLayout } = state;
  const { activeCommunity, activeCommunityId, viewerIsAgent, canManageWorkspace, search, setSearch, pinned } = view;
  const { roomListGestures, swipeableRefs, handleLeaveRoom, handleCloseChat, visibleRows: rows } = actions;
  const canCreate = !viewerIsAgent && canManageWorkspace;
  const workspaceName = chatList?.workspace.name ?? activeCommunity?.name ?? WORKSPACE_LABEL;
  // Desktop has no bare list in the middle: the top chat of the already loaded
  // list opens there (build spec, desktop walk "open: sidebar, #beeline in the middle").
  const desktopFirstChat = isDesktop && landing.kind === 'deck' ? rows[0]?.room.id : undefined;
  const openedDesktopChat = useRef(false);
  useEffect(() => {
    if (!desktopFirstChat || openedDesktopChat.current) return;
    openedDesktopChat.current = true;
    router.replace(roomHref(desktopFirstChat));
  }, [desktopFirstChat]);

  if (landing.kind === 'error') {
    return (
      <YStack flex={1} backgroundColor="canvas" testID="room-deck-unavailable">
        <SafeTop />
        <ChatListHeader workspaceName={workspaceName} search={search} onSearch={setSearch} />
        <YStack padding="4"><Copy small quiet testID="room-deck-error-retry">{error ?? ''}</Copy></YStack>
      </YStack>
    );
  }
  if (landing.kind !== 'deck' || !chatList) {
    // Other landings navigate above; pins only mark rows, so they never hold the list.
    return <RoomDeckLoadingView onLayout={onLayout} />;
  }

  const empty = (
    <EmptyRoomActions
      canAddRoom={canCreate}
      canConnectAgent={!viewerIsAgent}
      onAddRoom={() => state.setNewChatStep('menu')}
      onConnectAgent={() => void connectAgent()}
      testID={isDesktop ? 'desktop-room-list-empty' : 'room-list-empty'}
    />
  );
  const footer = (
    <>
      <MessageMatches
        search={view.messageSearch}
        now={ageNow}
        onOpen={(result) => {
          if (activeCommunityId) router.push(messageSearchHref(result, activeCommunityId) as Href);
        }}
      />
      {search.open ? null : <JoinableChats chats={chatList.joinable ?? []} joining={joining} onJoin={(id, name) => void join(id, name)} />}
    </>
  );
  const renderRow = (item: ChatListItem, index: number) => {
    const row = (
      <ChatRow
        item={item}
        viewer={chatList.viewer.pubkey}
        now={ageNow}
        first={index === 0}
        dividerOutside={!viewerIsAgent}
        last={index === rows.length - 1}
        pinned={pinned.includes(item.room.id)}
        onOpen={rowActions.press}
        onPin={rowActions.pin}
        onOpenThread={rowActions.thread}
        onNewThread={viewerIsAgent ? undefined : rowActions.newThread}
      />
    );
    if (viewerIsAgent) return row;
    const title = `${roomRowName(item).sigil}${roomRowName(item).name}`;
    return (
      <>
        {index === 0 ? null : <ChatRowDivider roomId={item.room.id} />}
        <Swipeable
          enabled={roomListGestures.swipesEnabled}
          activeOffsetX={[-15, 15]}
          failOffsetY={[-10, 10]}
          ref={(ref) => {
            if (ref) swipeableRefs.current.set(item.room.id, ref);
            else swipeableRefs.current.delete(item.room.id);
          }}
          friction={1}
          overshootRight={false}
          rightThreshold={ROW_HEIGHT}
          renderRightActions={() => (
            <YStack width={ROW_HEIGHT} backgroundColor="highlight" alignItems="center" justifyContent="center">
              {item.directMessage ? (
                <Btn kind="icon" label={`Close ${title}`} testID={`chat-close-action-${item.room.id}`}
                  onPress={() => { if (roomListGestures.canInteract()) void handleCloseChat(item); }}>
                  <Glyph icon={LogOut} />
                </Btn>
              ) : (
                <Btn kind="icon" label={`Leave ${title}`} testID={`room-leave-action-${item.room.id}`}
                  onPress={() => { if (roomListGestures.canInteract()) void handleLeaveRoom(item); }}>
                  <Glyph icon={LogOut} />
                </Btn>
              )}
            </YStack>
          )}
          testID={`chat-close-swipe-${item.room.id}`}
        >
          {row}
        </Swipeable>
      </>
    );
  };

  return (
    <BuzzCommunityShell
      communities={view.communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectWorkspace}
      onAdd={() => router.push('/beeline/community' as Href)}
    >
      <YStack flex={1} minHeight={0} backgroundColor="canvas" onLayout={onLayout} testID={refreshing ? 'room-list-refreshing' : 'room-list-idle'}>
        {isDesktop ? null : (
          <>
            <SafeTop />
            <DeckHeader workspaceName={workspaceName} onNew={canCreate ? () => state.setNewChatStep('menu') : undefined} search={search} onSearch={setSearch} />
            <Separator borderColor="stroke" />
          </>
        )}
        {view.pinError ? <YStack paddingHorizontal="4" paddingVertical="2"><Copy small color="removed">{view.pinError}</Copy></YStack> : null}
        {state.deletedWorkspaceNotice ? (
          <YStack paddingHorizontal="4" paddingVertical="2">
            <Btn kind="quiet" label={state.deletedWorkspaceNotice} onPress={() => state.setDeletedWorkspaceNotice(null)} testID="workspace-deleted-notice">
              <Copy small color="removed">{state.deletedWorkspaceNotice}</Copy>
            </Btn>
          </YStack>
        ) : null}
        {error ? <YStack paddingHorizontal="4" paddingVertical="2"><Copy small color="removed">{error}</Copy></YStack> : null}
        {isDesktop ? (
          chatList.chats.length === 0 ? empty : (
            <YStack flex={1} alignItems="center" justifyContent="center" gap="2" padding="6" testID="desktop-room-selection-empty">
              <Copy small quiet>Choose a chat from the sidebar.</Copy>
            </YStack>
          )
        ) : (
          <YStack flex={1} minHeight={0} testID="room-list-gestures" {...roomListGestures.touchHandlers}>
            <FlatList
              testID="room-list"
              {...roomListGestures.listHandlers}
              data={rows}
              keyExtractor={(item) => item.room.id}
              extraData={[roomListGestures.swipesEnabled, pinned, ageNow]}
              refreshing={refreshing}
              onRefresh={() => {
                state.setRefreshing(true);
                refreshNow();
              }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item, index }) => renderRow(item, index)}
              ListFooterComponent={footer}
              ListEmptyComponent={
                view.messageSearch.status !== 'unavailable' ? null
                  : search.open ? (
                    <YStack padding="4" gap="2" testID="room-list-no-match">
                      <Copy quiet>No chats match.</Copy>
                    </YStack>
                  ) : empty
              }
            />
          </YStack>
        )}
      </YStack>
      <NewChatSheet
        step={state.newChatStep}
        onStep={state.setNewChatStep}
        busy={state.creatingRoom}
        name={view.roomName}
        onName={view.setRoomName}
        onCreateEmpty={(name, inviteOnly) => void repositories.createChat(name, null, inviteOnly)}
        candidates={state.repoCandidates}
        installations={state.repoInstallations}
        loading={state.repoAccessLoading}
        error={state.repoPickerError}
        notice={state.repoPickerNotice}
        onLoadRepositories={() => void repositories.loadRepositories()}
        onConnectGitHub={() => void repositories.handleAddGitHubAccount()}
        onPickRepository={(candidate) => void repositories.createRepositoryChat(candidate)}
      />
      {state.agentConnectVisible && activeCommunityId ? (
        <WorkspaceAddAgentSheet workspaceId={activeCommunityId} close={closeAgentConnect} />
      ) : null}
    </BuzzCommunityShell>
  );
});
