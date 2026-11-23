import React, { useState } from 'react';
import { Input, ListItem, Switch, XStack, YStack } from 'tamagui';
import { FlatList } from 'react-native';
import { Lock, Pencil, Search } from 'lucide-react-native';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';
import { SelectedRepositoryPill } from '@/components/buzz/SelectedRepositoryPill';
import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import { GitHubMark } from '@/components/buzz/GitHubMark';
import { ROOM_SLUG_HINT, roomNameEntry, validRoomSlug } from '@/buzz/room-name';
import { filterRepoCandidates, type RepoCandidate } from '@/buzz/room-repo-picker';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Btn, Copy, Glyph, HEIGHT, SheetFrame, SheetRow, Spinner } from '@/ui/grammar';

export type NewChatStep = 'menu' | 'empty' | 'github';

export type NewChatSheetProps = {
  step: NewChatStep | null;
  onStep: (step: NewChatStep | null) => void;
  busy: boolean;
  /** The Start empty name, kept as today's text draft. */
  name: string;
  onName: (name: string) => void;
  onCreateEmpty: (name: string, inviteOnly: boolean) => void;
  candidates: readonly RepoCandidate[];
  installations: readonly GitHubInstallationAccess[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  onLoadRepositories: () => void;
  onConnectGitHub: () => void;
  onPickRepository: (candidate: RepoCandidate) => void;
};

/** The + in the list header: Start empty, or attach a GitHub repository. */
export function NewChatSheet(props: NewChatSheetProps) {
  const { step, onStep } = props;
  const close = () => onStep(null);
  return (
    <SheetFrame
      open={step !== null}
      close={close}
      title={step === 'github' ? 'Connect GitHub' : 'New chat'}
      back={step === 'menu' || step === null ? undefined : () => onStep('menu')}
      testID={`sheet-${step ?? 'menu'}`}
    >
      {step === 'empty' ? <StartEmpty {...props} /> : step === 'github' ? <RepositoryStep {...props} /> : (
        <>
          <SheetRow icon={<Glyph icon={Pencil} />} label="Start empty" onPress={() => onStep('empty')} testID="new-chat-empty" />
          <SheetRow
            icon={<GitHubMark />}
            label="Attach a GitHub repository…"
            onPress={() => { onStep('github'); props.onLoadRepositories(); }}
            testID="new-chat-github"
          />
        </>
      )}
    </SheetFrame>
  );
}

function StartEmpty({ name, onName, busy, onCreateEmpty }: NewChatSheetProps) {
  const [isPublic, setPublic] = useState(true);
  const slug = name.trim();
  const valid = validRoomSlug(slug);
  return (
    <YStack gap="3">
      <Input
        size="md"
        autoFocus
        placeholder="Name"
        aria-label={`${ROOM_LABEL} name`}
        disabled={busy}
        value={name}
        onChangeText={(value: string) => onName(roomNameEntry(value))}
        onSubmitEditing={() => { if (valid && !busy) onCreateEmpty(slug, !isPublic); }}
        testID="create-room-name"
      />
      {name.length > 0 && !valid ? <Copy small quiet testID="create-room-name-hint">{ROOM_SLUG_HINT}</Copy> : null}
      <XStack minHeight={HEIGHT.control} alignItems="center" gap="3">
        <YStack flex={1}><Copy>Public</Copy></YStack>
        <Switch checked={isPublic} onCheckedChange={setPublic} disabled={busy} aria-label={`Public ${ROOM_LABEL}`} testID="create-room-public">
          <Switch.Thumb />
        </Switch>
      </XStack>
      <Btn kind="primary" label={`Create ${ROOM_LABEL}`} disabled={!valid || busy} onPress={() => onCreateEmpty(slug, !isPublic)} testID="create-room-submit">
        {busy ? 'Creating…' : `Create ${ROOM_LABEL}`}
      </Btn>
    </YStack>
  );
}

function RepositoryStep({ candidates, installations, loading, error, notice, busy, onConnectGitHub, onPickRepository }: NewChatSheetProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<RepoCandidate | null>(null);
  const found = filterRepoCandidates(candidates, query, installations);
  const connected = installations.length > 0 || candidates.length > 0;
  return (
    <YStack gap="3">
      <SelectedRepositoryPill repository={selected} onClear={() => setSelected(null)} testIDPrefix="new-chat-repository" />
      <XStack alignItems="center" gap="2">
        <Glyph icon={Search} />
        <Input flex={1} minWidth={0} size="md" placeholder="Find a repository" aria-label="Find a repository" value={query} onChangeText={setQuery} testID="repo-search" />
      </XStack>
      {error ? <Copy small color="removed" testID="repo-picker-error">{error}</Copy> : null}
      {notice ? <Copy small quiet testID="repo-picker-notice">{notice}</Copy> : null}
      <YStack maxHeight={420}>
        <FlatList
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          testID="repo-list"
          data={found}
          keyExtractor={candidate => candidate.key}
          renderItem={({ item: candidate }) => (
            <ListItem
              key={candidate.key}
              minHeight={HEIGHT.primary}
              paddingHorizontal="1"
              gap="3"
              alignItems="center"
              justifyContent="flex-start"
              backgroundColor="raised"
              disabled={busy}
              onPress={() => { setSelected(candidate); onPickRepository(candidate); }}
              aria-label={`${candidate.name}${candidate.private ? ', private' : ''}`}
              accessibilityRole="button"
              testID={`repo-row-${candidate.key}`}
            >
              <RepositoryMark avatarUrl={candidate.avatarUrl} faviconUrl={candidate.faviconUrl} size={24} />
              <YStack flex={1} minWidth={0}><Copy>{candidate.name}</Copy></YStack>
              {candidate.private ? <Glyph icon={Lock} size={18} /> : null}
            </ListItem>
          )}
          ListFooterComponent={loading ? <YStack padding="3" alignItems="center"><Spinner /></YStack> : null}
          ListEmptyComponent={!loading && connected ? <Copy quiet>No repositories match.</Copy> : null}
        />
      </YStack>
      {!loading && !connected ? (
        <Btn label="Connect GitHub" onPress={onConnectGitHub} testID="repo-connect-github">Connect GitHub</Btn>
      ) : busy ? <Spinner /> : null}
    </YStack>
  );
}
