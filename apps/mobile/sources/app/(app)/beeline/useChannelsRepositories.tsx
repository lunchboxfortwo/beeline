import { appErrorCopy } from '@/buzz/app-error-copy';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import { validRoomSlug } from '@/buzz/room-name';
import { inviteOnlyForRepository, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { readGitHubAccess } from '@/buzz/github-access-surface';
import { chatNameForRepository } from '@/ui/screens/chats/chat-tree-model';
import { useCallback } from 'react';
import type { DeckPresentation } from './useChannelsPresentation';
import type { DeckState } from './useChannelsRouteState';

/** The New chat sheet's writes: Start empty, or a chat attached to a GitHub repository. */
export function useChannelsRepositories(
  {
    transport, githubScope, setRepoPickerError, relayUrl, identity, setRepoAccessLoading,
    setNewChatStep, setRepoPickerNotice, creatingRoom, setCreatingRoom, setError, chatStore,
  }: DeckState,
  { activeCommunityId, canManageWorkspace, roomNameDraft }: DeckPresentation,
  openRoom: (roomId: string) => void,
) {
  const loadRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId || !githubScope) return;
      const access = await readGitHubAccess(transport, githubScope, refresh);
      setRepoPickerError(
        access.githubReconnectNeeded
          ? 'GitHub sign-in expired — reconnect GitHub in Settings to see new repositories.'
          : null,
      );
    },
    [activeCommunityId, transport, relayUrl, identity?.publicKey],
  );

  const loadRepositories = useCallback(async () => {
    if (!transport || !activeCommunityId) return;
    setRepoPickerError(null);
    setRepoAccessLoading(true);
    try {
      await loadRepoPicker(true);
    } catch {
      setRepoPickerError('Could not load repos. Try again.');
    } finally {
      setRepoAccessLoading(false);
    }
  }, [activeCommunityId, loadRepoPicker, transport]);

  const startGitHubInstallation = useCallback(
    async (installationId?: number) => {
      if (!transport) throw new Error('GitHub transport is unavailable');
      return transport.githubInstallationStart(githubInstallationRedirectUri(), installationId);
    },
    [transport],
  );
  const refreshGitHubRepositories = useCallback(() => loadRepoPicker(true), [loadRepoPicker]);
  // A cold resume from the GitHub install lands back on the repository list.
  const resumeRepoPicker = useCallback(async () => setNewChatStep('github'), []);
  const { handleAddGitHubAccount } = useGitHubInstallationSession({
    ready: Boolean(transport && activeCommunityId),
    returnPath: '/beeline/channels',
    startInstallation: startGitHubInstallation,
    refreshRepositories: refreshGitHubRepositories,
    onError: setRepoPickerError,
    onNotice: setRepoPickerNotice,
    onColdResume: resumeRepoPicker,
  });

  /** Creates the chat, closes the sheet, reads the list again and opens the new chat. */
  const createChat = useCallback(
    async (name: string, repository: RepoCandidate | null, inviteOnly: boolean) => {
      if (!validRoomSlug(name) || !transport || !activeCommunityId || creatingRoom || !canManageWorkspace) return;
      setCreatingRoom(true);
      setError(null);
      const clearSubmittedRoom = repository ? () => undefined : roomNameDraft.capture();
      let publishAcknowledged = false;
      try {
        const roomId = await transport.createRoom(name, {
          communityId: activeCommunityId,
          visibility: inviteOnly ? 'invite-only' : 'public',
          repository: repository ?? undefined,
          onPublished: () => {
            publishAcknowledged = true;
            clearSubmittedRoom();
            setNewChatStep(null);
            chatStore.current?.force();
          },
        });
        if (!publishAcknowledged) {
          clearSubmittedRoom();
          setNewChatStep(null);
        }
        chatStore.current?.force();
        if (roomId) openRoom(roomId);
      } catch (reason) {
        setError(
          publishAcknowledged
            ? appErrorCopy(reason, `${ROOM_LABEL} created, but membership is still syncing.`)
            : appErrorCopy(reason, `Could not create ${ROOM_LABEL}.`),
        );
      } finally {
        setCreatingRoom(false);
      }
    },
    [activeCommunityId, canManageWorkspace, creatingRoom, openRoom, roomNameDraft, transport],
  );

  /** Picking a repository names the chat after it; a private repository starts invite-only. */
  const createRepositoryChat = useCallback(
    (candidate: RepoCandidate) =>
      createChat(chatNameForRepository(candidate), candidate, inviteOnlyForRepository(candidate)),
    [createChat],
  );
  return { loadRepositories, handleAddGitHubAccount, createChat, createRepositoryChat };
}
