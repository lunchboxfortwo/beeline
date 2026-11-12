import { RepositoryMark } from './RepositoryMark';
import { EmptyState } from './EmptyState';
import { ErrorBanner } from './ErrorBanner';
import { HullActionSheetRow } from './HullActionSheet';
import { HullDialogActions } from '@/components/buzz/HullDialog';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { memo, useMemo, useState } from 'react';
import { SectionList } from 'react-native';
import { XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import type { GitHubRepositoryLinkagePlan, RepoCandidate } from '@/buzz/room-repo-picker';
import {
  explainMissingRepo,
  filterRepoCandidates,
  GITHUB_REPOSITORY_SELECTION_INSTRUCTION,
  githubFullNameFromInput,
  githubRepositoryLinkagePlan,
  groupRepoCandidatesByOwner,
  repoShortName,
} from '@/buzz/room-repo-picker';
import { OwnerGrantNeededCard, type OwnerGrantNeeded } from './OwnerGrantNeededCard';

export type RepoPickerProps = {
  candidates: RepoCandidate[];
  installations?: GitHubInstallationAccess[];
  currentKey?: string | null;
  busy?: boolean;
  error?: string | null;
  fillAvailableHeight?: boolean;
  notice?: string | null;
  /**
   * A typed pending state: the chosen repository is not covered by the App
   * yet, and only its owner can grant access. Rendered as a share CTA, never
   * as an error.
   */
  ownerGrant?: OwnerGrantNeeded | null;
  onSelect: (candidate: RepoCandidate) => void;
  onSelectNoRepository?: () => void;
  onAddAccount?: (owner?: string) => void;
  onManageInstallation?: (installation: GitHubInstallationAccess) => void;
  onCreateRepository?: (installationId: number, name: string) => Promise<void> | void;
  /** Open a host-owned creation step instead of the picker's inline editor. */
  onStartCreateRepository?: () => void;
  /** Present only when the current viewer may unlink a bound Room repository. */
  onUnlink?: () => void;
  unlinkRepositoryName?: string | null;
  /**
   * The pasted repository's OWNER is not among this viewer's installations:
   * offer the share-with-owner path (the host probes the typed grant state
   * and shares the install link). Absent keeps the connect-only flow.
   */
  onAskOwnerGrant?: (fullName: string) => void;
  /** Owners the server has already reported as never covered (`owner_grant_needed`). */
  uncoveredOwners?: ReadonlySet<string>;
  testIDPrefix?: string;
  draftContext?: string;
};

/**
 * The candidate list is height-bounded and internally scrollable so an
 * account with 100+ repositories never renders past the fold: every host
 * (room-create panel, corner-open banner, Room-actions sheet) constrains it
 * to about six sheet rows.
 */
export const REPO_CANDIDATE_ROW_MIN_HEIGHT = 52;
export const REPO_CANDIDATE_VISIBLE_ROWS = 6;
export const REPO_CANDIDATE_LIST_MAX_HEIGHT =
  REPO_CANDIDATE_ROW_MIN_HEIGHT * REPO_CANDIDATE_VISIBLE_ROWS;

export const RepoPicker = memo(function RepoPicker({
  candidates,
  installations = [],
  currentKey,
  busy = false,
  error,
  fillAvailableHeight = false,
  notice,
  ownerGrant,
  onSelect,
  onSelectNoRepository,
  onAddAccount,
  onManageInstallation,
  onCreateRepository,
  onStartCreateRepository,
  onUnlink,
  unlinkRepositoryName,
  onAskOwnerGrant,
  uncoveredOwners,
  testIDPrefix = 'repo-picker',
  draftContext = 'global',
}: RepoPickerProps) {
  const [query, setQuery] = useTextDraft(`repo-search:${draftContext}:${testIDPrefix}`, '');
  const [creating, setCreating] = useState(false);
  const [createInstallationId, setCreateInstallationId] = useState<number | null>(null);
  const [newName, setNewName, repositoryDraft] = useTextDraft(
    `repo-create:${draftContext}:${testIDPrefix}:${createInstallationId ?? 'default'}`,
    '',
  );
  const [pendingLinkage, setPendingLinkage] = useState<Exclude<
    GitHubRepositoryLinkagePlan,
    { kind: 'available' }
  > | null>(null);
  const visible = useMemo(
    () => filterRepoCandidates(candidates, query, installations),
    [candidates, query, installations],
  );
  const activeInstallations = installations.filter(
    (installation) => installation.status === 'active',
  );
  const sections = useMemo(() => {
    const loginByOwner = new Map(
      installations.map((installation) => [installation.accountLogin.toLowerCase(), installation]),
    );
    return groupRepoCandidatesByOwner(visible).map((group) => ({
      key: group.owner ? `owner-${group.owner.toLowerCase()}` : 'ungrouped',
      owner: group.owner,
      installation: group.owner ? (loginByOwner.get(group.owner.toLowerCase()) ?? null) : null,
      data: group.data,
    }));
  }, [installations, visible]);
  // Headings are the repository owner. One GitHub App installation can grant
  // repos from several owners; grouping by installationId parked those under
  // the install account. Search already dropped empty groups.
  const pastedFullName = githubFullNameFromInput(query);
  const showLoadingPlaceholders = busy && visible.length === 0 && !error && !pastedFullName;
  const exactCandidate = pastedFullName
    ? candidates.find((candidate) => candidate.name.toLowerCase() === pastedFullName.toLowerCase())
    : undefined;
  const pastedOwner = pastedFullName?.split('/')[0];
  const ownerInstallation = pastedOwner
    ? installations.find(
        (installation) =>
          installation.status === 'active' &&
          installation.accountLogin.toLowerCase() === pastedOwner.toLowerCase(),
      )
    : undefined;
  // Named a repository that is not in the list? Say why before the user
  // decides Beeline simply lost it — an org repo is usually one grant away.
  const missing = useMemo(
    () =>
      pastedFullName && !exactCandidate
        ? explainMissingRepo(pastedFullName, candidates, installations, { uncoveredOwners })
        : null,
    [candidates, exactCandidate, installations, pastedFullName, uncoveredOwners],
  );

  const candidateRow = (candidate: RepoCandidate, owner: string | null) => (
    <HullActionSheetRow
      accessibilityLabel={candidate.name}
      disabled={busy}
      key={candidate.key}
      label={repoShortName(candidate, owner)}
      leading={<RepositoryMark avatarUrl={candidate.avatarUrl} faviconUrl={candidate.faviconUrl} size={28} />}
      selected={candidate.key === currentKey}
      onPress={() => onSelect(candidate)}
      testID={`${testIDPrefix}-candidate-${candidate.key}`}
    />
  );

  return (
    <YStack flexShrink={1} minHeight={0} flex={fillAvailableHeight ? 1 : undefined} testID={testIDPrefix}>
      <HullDialogInput
        accessibilityLabel="Search repositories or paste a GitHub URL"
        autoCapitalize="none"
        autoCorrect={false}
        readOnly={busy}
        onChangeText={(value) => {
          setQuery(value);
          setPendingLinkage(null);
        }}
        placeholder="Search or paste owner/repo"
        placeholderTextColor="secondary"
        variant="sheetSearch"
        value={query}
      />
      {onSelectNoRepository && (
        <HullActionSheetRow
          label="No repository"
          selected={!currentKey}
          onPress={onSelectNoRepository}
          testID={`${testIDPrefix}-no-repository`}
        />
      )}
      {ownerGrant && <OwnerGrantNeededCard {...ownerGrant} />}
      {/* Height-bounded so a 100+ repo account scrolls instead of rendering past
          the fold; six sheet rows, see REPO_CANDIDATE_LIST_MAX_HEIGHT. */}
      <YStack
        flexGrow={0}
        flex={fillAvailableHeight ? 1 : undefined}
        flexShrink={fillAvailableHeight ? 1 : undefined}
        minHeight={0}
        maxHeight={REPO_CANDIDATE_LIST_MAX_HEIGHT}
      >
      <SectionList
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          showLoadingPlaceholders ? (
            <YStack accessibilityLabel="Loading repositories" testID={`${testIDPrefix}-loading`}>
              {Array.from({ length: REPO_CANDIDATE_VISIBLE_ROWS }, (_, index) => (
                <XStack
                  key={index}
                  minHeight={52}
                  alignItems="center"
                  borderBottomWidth={1}
                  borderBottomColor="stroke"
                  testID={`${testIDPrefix}-placeholder-${index}`}
                >
                  <YStack height={1} width="42%" backgroundColor="stroke" />
                </XStack>
              ))}
            </YStack>
          ) : !error && !pastedFullName ? (
            <EmptyState title="No repositories match." />
          ) : null
        }
        nestedScrollEnabled
        renderItem={({ item, section }) => candidateRow(item, section.owner)}
        renderSectionHeader={({ section }) =>
          section.owner ? (
            // This SectionList sticks the whole row, including the trailing count.
            <XStack
              backgroundColor="highlight"
              alignItems="center"
              justifyContent="space-between"
              gap="2"
              paddingTop="4"
              paddingBottom="1"
              testID={`${testIDPrefix}-group-${section.owner.toLowerCase()}`}
            >
              <RoomListSectionHeader title={section.owner ?? ''} inset="content" spacing="flush" />
              <T v="meta" color="secondary">
                {section.installation && section.installation.status !== 'active'
                  ? section.installation.status.toUpperCase()
                  : `${section.data.length} ${section.data.length === 1 ? 'REPO' : 'REPOS'}`}
              </T>
            </XStack>
          ) : null
        }
        sections={sections}
        testID={`${testIDPrefix}-list`}
      />
      </YStack>
      {pastedFullName && !exactCandidate && (
        <YStack>
          {missing && <T v="meta" color="secondary" testID={`${testIDPrefix}-missing-reason`}>{missing.message}</T>}
          <HullActionSheetRow
            label={pastedFullName}
            description={ownerInstallation?.status === 'active'
              ? 'Add this repo to the Beeline installation'
              : `Connect ${pastedOwner}`}
            onPress={() => {
              const plan = githubRepositoryLinkagePlan(pastedFullName, candidates, installations, {
                uncoveredOwners,
              });
              if (plan.kind === 'available') onSelect(plan.candidate);
              else setPendingLinkage(plan);
            }}
            testID={`${testIDPrefix}-connect-card`}
          />
        </YStack>
      )}
      {pendingLinkage && (
        <YStack borderWidth={1} borderColor="needsYou" padding="3" gap="2" marginVertical="2" testID={`${testIDPrefix}-link-instruction`}>
          <T v="code" color="needsYou">ON GITHUB</T>
          <T v="code">{GITHUB_REPOSITORY_SELECTION_INSTRUCTION}</T>
          <HullDialogActions actions={[{ label: "Cancel", variant: "quiet", onPress: () => setPendingLinkage(null) }, { label: pendingLinkage.kind === 'owner-grant'
                  ? 'Share install link'
                  : 'Continue to GitHub', ...(pendingLinkage.kind === 'owner-grant' ? {} : { destination: 'external' as const }), variant: "primary", onPress: () => {
                const plan = pendingLinkage;
                setPendingLinkage(null);
                if (plan.kind === 'manage') onManageInstallation?.(plan.installation);
                else if (plan.kind === 'owner-grant') onAskOwnerGrant?.(plan.fullName);
                else onAddAccount?.(plan.owner || undefined);
              }, testID: `${testIDPrefix}-link-continue` }]} />
        </YStack>
      )}
      {onCreateRepository && activeInstallations.length > 0 && (
        <YStack>
          <HullActionSheetRow
            label="Create repository"
            disabled={busy}
            onPress={() => {
              if (onStartCreateRepository) {
                onStartCreateRepository();
                return;
              }
              setCreating((value) => !value);
              setCreateInstallationId(
                (current) => current ?? activeInstallations[0]!.installationId,
              );
            }}
            testID={`${testIDPrefix}-create-repo`}
          />
          {creating && !onStartCreateRepository && (
            <YStack gap="2" paddingBottom="4">
              <YStack>
                {activeInstallations.map((installation) => (
                  <HullActionSheetRow
                    key={installation.installationId}
                    label={installation.accountLogin}
                    selected={createInstallationId === installation.installationId}
                    disabled={busy}
                    onPress={() => setCreateInstallationId(installation.installationId)}
                  />
                ))}
              </YStack>
              <XStack gap="2">
                <YStack flex={1} minWidth={0}>
                  <HullDialogInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setNewName}
                    placeholder="repository-name"
                    placeholderTextColor="secondary"
                    value={newName}
                  />
                </YStack>
                <HullDialogActions actions={[{
                  label: 'CREATE',
                  variant: 'primary',
                  disabled: busy || !createInstallationId || !/^[A-Za-z0-9._-]{1,100}$/.test(newName),
                  onPress: () => {
                    if (!createInstallationId) return;
                    const clearRepository = repositoryDraft.capture();
                    void Promise.resolve(onCreateRepository(createInstallationId, newName))
                      .then(() => {
                        clearRepository();
                        setCreating(false);
                      })
                      .catch(() => undefined);
                  },
                }]} />
              </XStack>
            </YStack>
          )}
        </YStack>
      )}
      {onAddAccount && (
        <HullActionSheetRow
          label="Add repositories, accounts, or organizations"
          disabled={busy}
          onPress={() => setPendingLinkage({ kind: 'install', owner: '', fullName: '' })}
          testID={`${testIDPrefix}-add-account`}
        />
      )}
      {onUnlink && unlinkRepositoryName ? (
        <HullActionSheetRow
          label="Unlink repo"
          accessibilityLabel={`Unlink repo, currently ${unlinkRepositoryName}`}
          disabled={busy}
          destructive
          onPress={onUnlink}
          testID={`${testIDPrefix}-unlink`}
        />
      ) : null}
      {notice && !error && (
        <T v="code" color="secondary" paddingTop="2" accessibilityLiveRegion="polite">
          {notice}
        </T>
      )}
      {error && (
        <ErrorBanner inline title={`! ${error}`} />
      )}
    </YStack>
  );
});
