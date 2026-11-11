import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { type ChatListHandle } from '@/buzz/chat-list-store';
import { mobileSurfaceCache, surfaceAddress, restoreStoredSurface } from '@/buzz/surface-storage';
import { useGitHubAccess } from '@/buzz/github-access-surface';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { BuzzRigTransport } from '@/sync/transport';
import { useIsDesktop } from '@/utils/responsive';
import { isChatListView, isWorkspaceListView, type ChatListView } from '@beeline/buzz-client';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { afterFirstFrame, FirstContentDrawContext } from '@/navigation/initial-landing';
import type { NewChatStep } from '@/ui/screens/chats/NewChatSheet';
import { firstParam, type DeckSession } from './channels';

/** The deck's route, live list and sheet state, shared by the deck's other hooks. */
export function useChannelsRouteState(session: DeckSession) {
  const [retryGeneration] = useState(0);
  const isDesktop = useIsDesktop();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    newRoom?: string | string[];
  }>();
  const requestedWorkspaceId = firstParam(params.communityId);
  // The route's Workspace wins; without one the deck follows the current Workspace.
  const deckWorkspaceId = requestedWorkspaceId ?? session.workspaceId;
  const requestedNewRoom = firstParam(params.newRoom);
  const { identity, relayUrl } = session;
  const transport = useMemo(() => new BuzzRigTransport(identity), [identity]);
  const workspaceListAddress = useMemo(
    () => surfaceAddress(relayUrl, identity.publicKey, '/workspaces'),
    [identity.publicKey, relayUrl],
  );
  const workspaceList = useSurfaceSnapshot(workspaceListAddress, isWorkspaceListView);
  // Only a live read (never a cached one) may say "you have no Workspace".
  const [confirmedWorkspaceCount, setConfirmedWorkspaceCount] = useState<number | null>(null);

  const [selectedId] = useState(() => deckWorkspaceId ?? mobileSurfaceCache.peek(workspaceListAddress, isWorkspaceListView)?.workspaces[0]?.id);
  const [chatList, setChatList] = useState<ChatListView | null>(() => selectedId
    ? restoreStoredSurface(surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/chats', { workspaceId: selectedId }), isChatListView)
    : null);
  const notifyDraw = useContext(FirstContentDrawContext);
  const [drawn, setDrawn] = useState(false);
  const firstLayout = useRef<(() => void) | null>(null);
  const onLayout = useCallback(() => {
    if (firstLayout.current) return;
    notifyDraw();
    firstLayout.current = afterFirstFrame(() => setDrawn(true));
  }, [notifyDraw]);
  useEffect(() => () => { firstLayout.current?.(); firstLayout.current = null; }, []);
  useLatencyRouteFrame('/beeline/channels', chatList !== null, true);
  // A covering list read seeds the Needs-you rows behind the badge;
  // ordinary changes carry typed row deltas on the live socket.
  const [needsYouSignal, setNeedsYouSignal] = useState(0);
  const needsYouCount = useNeedsYouCount(
    chatList?.workspace.id,
    needsYouSignal === 0 ? undefined : needsYouSignal,
    () => deckVisible(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedWorkspaceNotice, setDeletedWorkspaceNotice] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [agentConnectVisible, setAgentConnectVisible] = useState(false);
  const [newChatStep, setNewChatStep] = useState<NewChatStep | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const githubScope = relayUrl && identity ? { relay: relayUrl, viewer: identity.publicKey } : null;
  const githubAccess = useGitHubAccess(githubScope);
  const repoCandidates = githubAccess?.candidates ?? [];
  const repoInstallations = githubAccess?.installations ?? [];
  const [repoAccessLoading, setRepoAccessLoading] = useState(false);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [repoPickerNotice, setRepoPickerNotice] = useState<string | null>(null);
  const handledNewRoomRequest = useRef<string | null>(null);
  const chatStore = useRef<ChatListHandle | null>(null);
  const readWorkspaceRef = useRef<(() => Promise<void>) | null>(null);
  const deckFocusedRef = useRef(true);
  const deckVisible = useCallback(
    () => deckFocusedRef.current && AppState.currentState === 'active',
    [],
  );
  /** Reads the hidden deck skipped; returning to it makes exactly those. */
  const deckMissedRef = useRef({ workspaces: false });
  return {
    workspaceList, requestedWorkspaceId, chatList, identity, relayUrl, isDesktop, requestedNewRoom,
    handledNewRoomRequest, newChatStep, setNewChatStep, readWorkspaceRef, chatStore, deckMissedRef,
    transport, setError, drawn, setConfirmedWorkspaceCount, deckVisible, deckFocusedRef,
    setDeletedWorkspaceNotice, selectedId, setChatList, setRefreshing, setNeedsYouSignal,
    retryGeneration, setAgeNow, githubScope, setRepoPickerError, setRepoAccessLoading,
    setRepoPickerNotice, creatingRoom, setCreatingRoom, confirmedWorkspaceCount, error,
    setAgentConnectVisible, onLayout, refreshing,
    needsYouCount, repoAccessLoading, repoCandidates, repoInstallations, repoPickerError,
    repoPickerNotice, agentConnectVisible, deletedWorkspaceNotice, ageNow,
  };
}

export type DeckState = ReturnType<typeof useChannelsRouteState>;
