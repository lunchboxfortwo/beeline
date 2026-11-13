import { deckLanding } from '@/buzz/deck-landing';
import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';
import type { DeckPresentation } from './useChannelsPresentation';
import type { DeckState } from './useChannelsRouteState';

/** Which landing the deck shows, and the empty deck's Connect an agent. */
export function useChannelsCompose(
  {
    confirmedWorkspaceCount, error, chatList, setAgentConnectVisible,
  }: DeckState,
  { activeCommunityId, viewerIsAgent }: DeckPresentation,
) {
  const landing = deckLanding({
    workspaces:
      confirmedWorkspaceCount !== null
        ? { status: 'ready', count: confirmedWorkspaceCount }
        : error
          ? { status: 'failed' }
          : { status: 'pending' },
    chats: chatList ? 'ready' : error ? 'failed' : 'pending',
  });
  const noWorkspace = landing.kind === 'choice';
  useEffect(() => {
    if (noWorkspace) router.replace('/beeline/community');
  }, [noWorkspace]);

  // The People tab's Add an agent sheet, which mints the pairing command itself.
  const connectAgent = useCallback(async () => {
    if (!activeCommunityId || viewerIsAgent) return;
    setAgentConnectVisible(true);
  }, [activeCommunityId, viewerIsAgent]);

  const closeAgentConnect = useCallback(() => {
    setAgentConnectVisible(false);
  }, []);
  return { landing, closeAgentConnect, connectAgent };
}
