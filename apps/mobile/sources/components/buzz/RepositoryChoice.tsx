import { RepositoryMark } from './RepositoryMark';
import { IndexRow, IndexRowInsetContext } from './IndexRow';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';
import { HullActionSheetRow } from './HullActionSheet';
import { HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { githubFullNameFromInput, type RepoCandidate } from '@/buzz/room-repo-picker';
import { Copy, STEP, T } from '@/ui/grammar';

export type RepoMode = 'none' | 'link' | 'create';

const MODES: { mode: RepoMode; label: string }[] = [
  { mode: 'none', label: 'None' },
  { mode: 'link', label: 'Link' },
  { mode: 'create', label: 'Create' },
];

const OWNER_MENU_MAX_ROWS = 4;

function repoFullName(candidate: RepoCandidate): string | null {
  return (
    githubFullNameFromInput(candidate.name) ??
    (candidate.remote ? githubFullNameFromInput(candidate.remote) : null)
  );
}

export function splitFullName(candidate: RepoCandidate): { owner: string | null; name: string } {
  const full = repoFullName(candidate);
  if (!full) return { owner: null, name: candidate.name };
  const [owner, name] = full.split('/');
  return { owner: owner ?? null, name: name ?? candidate.name };
}

/** What both repository sheets derive from the name a new repo would take. */
export function repositoryChoiceFacts({
  name,
  candidates,
  installations,
  installationId,
}: {
  name: string;
  candidates: readonly RepoCandidate[];
  installations: readonly GitHubInstallationAccess[];
  installationId: number | null;
}) {
  const activeInstallations = installations.filter((item) => item.status === 'active');
  const selectedInstallation =
    activeInstallations.find((item) => item.installationId === installationId) ??
    activeInstallations[0];
  const sameName = (candidate: RepoCandidate, owner?: string) => {
    const parts = splitFullName(candidate);
    return (
      parts.name.toLowerCase() === name.toLowerCase() &&
      (!owner || parts.owner?.toLowerCase() === owner.toLowerCase())
    );
  };
  const nameMatch = name ? (candidates.find((candidate) => sameName(candidate)) ?? null) : null;
  const takenRepo =
    name && selectedInstallation
      ? (candidates.find((candidate) => sameName(candidate, selectedInstallation.accountLogin)) ??
        null)
      : null;
  return {
    activeInstallations,
    selectedInstallation,
    nameMatch,
    takenRepo,
    githubConnected: activeInstallations.length > 0,
  };
}

/**
 * Wraps a Connect action so the org it connects comes back selected: the
 * first active installation that was not there when Connect was pressed
 * becomes the owner.
 */
export function useSelectConnectedOwner(
  installations: readonly GitHubInstallationAccess[],
  setInstallationId: (installationId: number) => void,
) {
  const before = useRef<Set<number> | null>(null);
  const activeIds = installations
    .filter((item) => item.status === 'active')
    .map((item) => item.installationId);
  const activeKey = activeIds.join(',');
  useEffect(() => {
    if (!before.current) return;
    const added = activeIds.find((id) => !before.current!.has(id));
    if (added === undefined) return;
    before.current = null;
    setInstallationId(added);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  return (connect?: () => void) =>
    connect &&
    (() => {
      before.current = new Set(activeIds);
      connect();
    });
}

type Props = {
  /** Prefix for every testID, e.g. `create-room` gives `create-room-repo-mode`. */
  testIDPrefix: string;
  busy: boolean;
  mode: RepoMode;
  onChooseMode: (mode: RepoMode) => void;
  loading: boolean;
  githubConnected: boolean;
  onConnect?: () => void;
  linkRepo: RepoCandidate | null;
  onOpenList: () => void;
  activeInstallations: GitHubInstallationAccess[];
  selectedInstallation: GitHubInstallationAccess | undefined;
  onSelectInstallation: (installationId: number) => void;
  ownerMenuOpen: boolean;
  setOwnerMenuOpen: (open: boolean) => void;
  createName: string;
  takenRepo: RepoCandidate | null;
  onLinkInstead: (repo: RepoCandidate) => void;
  error?: string | null;
  notice?: string | null;
  /**
   * Grow the block upward so the owner menu, which hangs over the switch,
   * fits inside it. For a sheet with nothing above the switch for the menu to
   * cover, which would otherwise clip it.
   */
  reserveOwnerMenuSpace?: boolean;
};

/**
 * The Repository control's revealed None / Link / Create switch. New Room and
 * the Room header sheet each own their own flat, unboxed collapsed row and
 * mount this only once the viewer taps it.
 */
export function RepositoryChoice({
  testIDPrefix: p,
  busy,
  mode,
  onChooseMode,
  loading,
  githubConnected,
  onConnect,
  linkRepo,
  onOpenList,
  activeInstallations,
  selectedInstallation,
  onSelectInstallation,
  ownerMenuOpen,
  setOwnerMenuOpen,
  createName,
  takenRepo,
  onLinkInstead,
  error,
  notice,
  reserveOwnerMenuSpace = false,
}: Props) {
  const [menuHeight, setMenuHeight] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  const connectRow = <IndexRow title="GitHub" value="Connect GitHub" chevron="right"
    disabled={busy || !onConnect} onPress={onConnect} testID={`${p}-github-connect`} />;
  const loadingRow = <IndexRow title="Loading GitHub…" tone="quiet" testID={`${p}-repo-loading`} />;
  const linkRow = () => {
    const parts = linkRepo ? splitFullName(linkRepo) : null;
    return <IndexRow leading={linkRepo ? <RepositoryMark avatarUrl={linkRepo.avatarUrl} faviconUrl={linkRepo.faviconUrl} size={28} /> : undefined} title={parts?.name ?? 'Choose a repo'} description={parts?.owner ?? undefined}
      accessibilityLabel={linkRepo ? `Linked repository ${repoFullName(linkRepo) ?? linkRepo.name}` : 'Choose a repo'}
      disabled={busy} onPress={onOpenList} chevron="right" testID={`${p}-repo-link`} />;
  };
  const createRow = () => <YStack testID={`${p}-repo-create`}>
    <IndexRow leading={<RepositoryMark avatarUrl={selectedInstallation?.accountAvatarUrl} faviconUrl={selectedInstallation?.faviconUrl} size={28} />} title={selectedInstallation?.accountLogin ?? ''} disabled={busy}
      accessibilityLabel={`Owner ${selectedInstallation?.accountLogin ?? ''}, change`}
      accessibilityState={{ expanded: ownerMenuOpen }} onPress={() => setOwnerMenuOpen(!ownerMenuOpen)}
      chevron={ownerMenuOpen ? 'up' : 'down'} testID={`${p}-repo-owner`} />
    <IndexRow title={createName || 'room-name'} tone={createName ? undefined : 'quiet'} />
    {takenRepo && <IndexRow title="Already exists." actionControl={{label:'Link it instead',
      onPress:()=>onLinkInstead(takenRepo),testID:`${p}-repo-link-instead`}} />}
  </YStack>;

  const ownerMenu = (
    // The owner menu hangs above the row it changes and covers the switch.
    <YStack
      onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
      position="absolute"
      left={0}
      right={0}
      bottom="100%"
      marginBottom="1"
      zIndex={3}
      padding="1"
      borderWidth={1}
      borderColor="strongStroke"
      borderRadius="sm"
      backgroundColor="raised"
      testID={`${p}-owner-menu`}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        maxHeight={HULL_SHEET_ROW_HEIGHT * OWNER_MENU_MAX_ROWS}
      >
        {activeInstallations.map((installation) => (
          <HullActionSheetRow
            key={installation.installationId}
            label={installation.accountLogin}
            selected={installation.installationId === selectedInstallation?.installationId}
            disabled={busy}
            onPress={() => {
              onSelectInstallation(installation.installationId);
              setOwnerMenuOpen(false);
            }}
            testID={`${p}-owner-${installation.installationId}`}
          />
        ))}
      </ScrollView>
      {onConnect && (
        <HullActionSheetRow
          label="Connect another org"
          disabled={busy}
          onPress={() => {
            setOwnerMenuOpen(false);
            onConnect();
          }}
          testID={`${p}-owner-connect`}
        />
      )}
    </YStack>
  );

  const slot = () => {
    if (!githubConnected) return loading ? loadingRow : connectRow;
    return mode === 'link' ? linkRow() : createRow();
  };

  const menuShown = ownerMenuOpen && mode === 'create' && githubConnected;
  // The menu ends `xs` above the slot, which starts `sm` below the switch.
  const reserved =
    reserveOwnerMenuSpace && menuShown
      ? Math.max(0, menuHeight + STEP['1'] - headHeight - STEP['2'])
      : 0;

  return (
    <IndexRowInsetContext.Provider value="flush">
    <YStack paddingVertical="2">
      {reserved > 0 && <YStack height={reserved} testID={`${p}-owner-menu-space`} />}
      <YStack
        onLayout={(event) => setHeadHeight(event.nativeEvent.layout.height)}
        testID={`${p}-repo-head`}
      >
        {/* Open, the label keeps the place and the type of the closed sheet row. */}
        <YStack paddingVertical="2" justifyContent="center">
          <Copy>Repository</Copy>
        </YStack>
        {/* A quiet switch on the sheet's own surface: no track fill. */}
        <XStack marginTop="1" gap="1" testID={`${p}-repo-mode`}>
          {MODES.map(({mode:option,label})=><YStack key={option} flex={1}><Button label={label}
            variant={mode===option ? 'brass' : 'secondary'} disabled={busy}
            accessibilityState={{selected:mode===option}} onPress={()=>onChooseMode(option)}
            fullWidth testID={`${p}-repo-mode-${option}`} /></YStack>)}
        </XStack>
      </YStack>
      {mode !== 'none' && (
        <YStack position="relative" zIndex={2} marginTop="2">
          {menuShown && ownerMenu}
          {slot()}
        </YStack>
      )}
      {!!error && (
        <ErrorBanner inline title={error} testID={`${p}-repo-error`} />
      )}
      {mode !== 'none' && !error && !!notice && (
        <T v="meta" color="secondary" marginTop="2" accessibilityLiveRegion="polite">
          {notice}
        </T>
      )}
    </YStack>
    </IndexRowInsetContext.Provider>
  );
}
