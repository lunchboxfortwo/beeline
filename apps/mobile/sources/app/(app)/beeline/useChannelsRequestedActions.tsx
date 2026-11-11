import { useCallback, useEffect } from 'react';
import type { DeckPresentation } from './useChannelsPresentation';
import type { DeckState } from './useChannelsRouteState';

/** The desktop sidebar's + arrives as a one-shot `newRoom` param; the deck's covering reads. */
export function useChannelsRequestedActions(
  { isDesktop, requestedNewRoom, handledNewRoomRequest, chatList, setNewChatStep, readWorkspaceRef, chatStore, deckMissedRef }: DeckState,
  { viewerIsAgent, canManageWorkspace, activeCommunityId }: DeckPresentation,
) {
  useEffect(() => {
    if (
      !isDesktop ||
      !requestedNewRoom ||
      requestedNewRoom === handledNewRoomRequest.current ||
      !chatList ||
      viewerIsAgent ||
      !canManageWorkspace
    ) {
      return;
    }
    handledNewRoomRequest.current = requestedNewRoom;
    setNewChatStep('menu');
  }, [canManageWorkspace, chatList, isDesktop, requestedNewRoom, viewerIsAgent]);

  const refreshNow = useCallback(() => {
    void readWorkspaceRef.current?.();
    chatStore.current?.force();
  }, [activeCommunityId]);

  const refreshMissed = useCallback(() => {
    if (deckMissedRef.current.workspaces) void readWorkspaceRef.current?.();
    chatStore.current?.catchUp();
    deckMissedRef.current = { workspaces: false };
  }, []);
  return { refreshMissed, refreshNow };
}
