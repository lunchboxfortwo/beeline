import { EmptyState } from '@/components/buzz/EmptyState';
import { githubConnectionErrorNotice } from '@/auth/github-connection-error';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { resolveAgentDisplayIdentity, type DisplayableAgent } from '@/buzz/agent-display';
import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import React, { useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { AppState, Platform } from 'react-native';
import { YStack } from 'tamagui';
import type { RepositoryOnboardingAction, RepositoryOnboardingCard as Card } from '@beeline/api-contract/phone';
import { TranscriptCard, type TranscriptCardAction, type TranscriptCardChoice } from '@/components/buzz/TranscriptCard';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { T } from '@/ui/grammar';

const GITHUB_CONNECTION_ERROR_CODES = new Set([
  'github_account_already_linked',
  'github_installation_admin_required',
  'github_account_mismatch',
  'github_connection_canceled',
  'github_connection_failed',
  'browser_canceled',
]);

type CardError = { title: string; description: string };

function repositoryActionError(action: RepositoryOnboardingAction['action'], reason: unknown): CardError {
  const code = reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string'
    ? reason.code
    : undefined;
  if (action === 'install' || action === 'organization' || (code && GITHUB_CONNECTION_ERROR_CODES.has(code))) {
    return { title: "GitHub didn't connect", description: githubConnectionErrorNotice(code ?? 'unknown').description };
  }
  if (action === 'create') {
    return { title: "Couldn't create repository", description: appErrorCopy(reason, 'Could not create the repository. Try again.') };
  }
  if (action === 'link') {
    return { title: "Couldn't link repository", description: appErrorCopy(reason, 'Could not link the repository. Try again.') };
  }
  return { title: "Couldn't refresh repositories", description: appErrorCopy(reason, 'Could not refresh repositories. Try again.') };
}

function isInvalidRepositoryName(name: string): boolean {
  return name.length > 0 && (
    name === '.' ||
    name === '..' ||
    /\.git$/i.test(name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  );
}

/** Reuses the shared ask-card anatomy; selections remain authoritative on the server. */
type Props = { card: Card; viewerId: string; author?: RoomViewIdentity; agent?: DisplayableAgent };
export function RepositoryOnboardingCard(props: Props) {
  const enabled = useRepositoryOnboarding();
  return enabled && props.card.kind === 'repository' ? <EnabledRepositoryOnboardingCard {...props} /> : null;
}
function EnabledRepositoryOnboardingCard({ card, viewerId, author, agent }: Props) {
  const { repositoryPicker, githubConnectionError } = useLocalSearchParams<{ repositoryPicker?: string; githubConnectionError?: string }>();
  const connectionError = repositoryPicker === card.id && card.requesterId === viewerId ? githubConnectionError : undefined;
  const named = card.selected?.trim().toLowerCase();
  const [picker, setPicker] = useState(repositoryPicker === card.id || Boolean(named));
  const [busy, setBusy] = useState(false);
  const [repoName, setRepoName] = useState(card.defaultName);
  const [nameEdited, setNameEdited] = useState(false);
  const [error, setError] = useState<CardError | null>(connectionError
    ? { title: "GitHub didn't connect", description: githubConnectionErrorNotice(connectionError).description }
    : null);
  useEffect(() => {
    setRepoName(card.defaultName);
    setNameEdited(false);
  }, [card.id]);
  useEffect(() => {
    if (!nameEdited) setRepoName(card.defaultName);
  }, [card.defaultName, nameEdited]);
  useEffect(() => {
    if (!connectionError) return;
    setError({ title: "GitHub didn't connect", description: githubConnectionErrorNotice(connectionError).description });
    router.setParams({ githubConnectionError: undefined });
  }, [connectionError]);
  const lastAction = useRef<{ action: RepositoryOnboardingAction['action']; extra: Partial<RepositoryOnboardingAction> }>({ action: 'install', extra: {} });
  const canAct = card.status === 'open' && card.requesterId === viewerId && !busy;
  const trimmedName = repoName.trim();
  const nameInvalid = isInvalidRepositoryName(trimmedName);
  const canCreate = canAct && trimmedName.length > 0 && !nameInvalid;
  const act = async (action: RepositoryOnboardingAction['action'], extra: Partial<RepositoryOnboardingAction> = {}) => {
    if (!canAct) return;
    lastAction.current = { action, extra };
    setBusy(true);
    setError(null);
    const request = { roomId: card.roomId, cardId: card.id, action, ...extra };
    try {
      if (action === 'install' || action === 'organization') {
        const [{ authSessionOptions }, { openAccountAuthSession, subscribeToAuthUrls },
          { githubInstallationRedirectUri, runGitHubInstallationSession, clearPendingGitHubInstallation }] = await Promise.all([
          import('@/auth/auth-session'), import('@/auth/desktop-auth-session'), import('@/auth/github-auth-session'),
        ]);
        const result = await monolithPhoneOperation('actOnRepositoryCard', {
          ...request, redirectUri: githubInstallationRedirectUri(),
        });
        if (result.openPicker) { setPicker(true); return; }
        if (!result.url) throw new Error('GitHub installation could not start. Try again.');
        await runGitHubInstallationSession({
          returnPath: `/beeline/chat/${card.roomId}?repositoryPicker=${card.id}`,
          startInstallation: async () => result.url!,
          onRefreshPhase: phase => {
            if (phase === 'refresh_failed') {
              setError({ title: "GitHub didn't connect", description: 'Connect to Wi-Fi or mobile data, then try again.' });
            }
          },
          openAuthSession: (url, redirect) => openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
          subscribeToUrls: subscribeToAuthUrls,
          subscribeToAppState: listener => AppState.addEventListener('change', listener),
          refreshRepositories: async () => { await monolithPhoneOperation('actOnRepositoryCard', { ...request, action: 'refresh' }); },
        });
        setPicker(true);
        // The mounted Room card has consumed the native return destination.
        // Web's landing tab still needs the shared path until it redirects.
        if (Platform.OS !== 'web') await clearPendingGitHubInstallation();
      } else await monolithPhoneOperation('actOnRepositoryCard', request);
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code : 'unknown';
      if (code === 'browser_canceled' && Platform.OS !== 'web') {
        const { clearPendingGitHubInstallation } = await import('@/auth/github-auth-session');
        await clearPendingGitHubInstallation();
      }
      setError(repositoryActionError(action, reason));
    } finally { setBusy(false); }
  };
  const choices: TranscriptCardChoice[] = picker
    ? card.repositories.map((repository, index) => ({ id: String(repository.id), letter: String(index + 1), mark: repository.current ? 'none' as const : 'chevron' as const,
      label: repository.fullName,
      selected: repository.current || repository.fullName.toLowerCase() === named, ...(canAct && !repository.current ? { onPress: () => void act('link', { repositoryId: repository.id }) } : {}) }))
    : [];
  const actions: TranscriptCardAction[] = card.canLink && card.status === 'open' && card.requesterId === viewerId ? [
    ...(card.githubLinked === false && !card.installationId ? [] : [
      { label: 'Link existing', disabled: !canAct, onPress: () => setPicker(!picker), testID: 'repo-card-link' },
      { label: 'Link an org', disabled: !canAct, onPress: () => void act('organization'), testID: 'repo-card-org' },
    ]),
    ...(card.installationId ? [{ label: 'Create new repo', primary: true, loading: busy,
      disabled: !canCreate, onPress: () => void act('create', { name: trimmedName }), testID: 'repo-card-create' }] : [{ label: card.githubLinked === false ? 'Connect GitHub' : 'Install Beeline', primary: true,
      loading: busy, disabled: !canAct, onPress: () => void act('install'), testID: 'repo-card-install' }]),

  ] : [];
  const linked = card.status === 'settled' && Boolean(card.repository);
  const needsConnection = card.githubLinked === false && !card.installationId;
  const showCreateInput = !linked && !error && !picker && card.canLink && card.status === 'open' && card.requesterId === viewerId && Boolean(card.installationId);
  const shownActions: TranscriptCardAction[] = linked ? [] : error ? (canAct ? [
    { label: 'Dismiss', dismiss: true, labelTone: 'quiet', onPress: () => { setError(null); setPicker(false); router.setParams({ githubConnectionError: undefined }); }, testID: 'repo-card-dismiss' },
    { label: 'Try again', primary: true, onPress: () => { router.setParams({ githubConnectionError: undefined }); void act(lastAction.current.action, lastAction.current.extra); }, testID: 'repo-card-retry' },
  ] : []) : actions;
  const display = resolveAgentDisplayIdentity(card.agentId, agent);
  return <TranscriptCard
    identity={
      <IdentityMark
        kind="agent"
        seed={display.avatarSeed}
        avatarUrl={display.avatarUrl ?? author?.avatar}
        face={display.face ?? author?.face}
        name={agent ? display.name : author?.name}
        size={26}
      />
    }
    tier={linked || card.status !== 'open' ? 'record' : 'ask'}
    testID={`repository-onboarding-${card.kind}`}
    title={linked ? 'Repository linked' : card.repository ? 'Switch repository' : !card.canLink ? 'No repository yet' : 'Choose a repository'}
    subline={linked ? card.repository : undefined}
    compactBody primaryBody footerDivider={false}
    balancedFooterInset={Platform.OS !== 'web' && needsConnection && !error && card.status === 'open' && shownActions.length > 0}
    inlineError={!linked && error ? error : undefined}
    body={linked || error || showCreateInput || picker ? undefined : card.canLink ? needsConnection
      ? 'Connect GitHub to link one you own or create a new private repo. You approve once on github.com, then come back here.'
      : card.installationId
        ? `New repo: ${card.defaultName}`
        : 'Install Beeline on GitHub to create a private repo or link one you own.'
      : card.ownerHandle ? `Ask @${card.ownerHandle} to link a repository for this chat` : 'Ask a Workspace owner or admin to choose a repository for this chat.'}
    choices={linked || error ? [] : choices} actions={shownActions}
    footerNote={!linked && busy ? 'Working…' : undefined}>
    {showCreateInput ? (
      <YStack gap="2">
        <T v="meta" color="secondary">
          {card.installationAccount ? `New private repo · ${card.installationAccount}/` : 'New private repo'}
        </T>
        <HullDialogInput
          variant="boxed"
          accessibilityLabel="New repository name"
          value={repoName}
          onChangeText={(value) => { setNameEdited(true); setRepoName(value); }}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          importantForAutofill="no"
          textContentType="none"
          readOnly={busy}
          maxLength={100}
          placeholder={card.defaultName}
          testID="repo-card-name-input"
        />
        {nameInvalid ? (
          <T v="meta" color="secondary" role="alert">
            Use letters, numbers, hyphens, dots, or underscores.
          </T>
        ) : null}
      </YStack>
    ) : null}
    {!linked && !error && picker && !card.repositories.length ?
      <EmptyState title="No repositories found. Install Beeline, then try again." /> : null}
  </TranscriptCard>;
}
