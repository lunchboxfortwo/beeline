import { RepositoryMark } from './RepositoryMark';
import { EmptyState } from './EmptyState';
import { HullActionSheetRow } from './HullActionSheet';
import { HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import React, { useMemo } from 'react';
import { SectionList } from 'react-native';
import { YStack } from 'tamagui';
import { Placeheld } from '@/ui/grammar';
import { useTextDraft } from '@/buzz/use-text-draft';
import {
  filterRepoCandidates,
  groupRepoCandidatesByOwner,
  repoShortName,
  type RepoCandidate,
} from '@/buzz/room-repo-picker';

// Six rows, then the list scrolls.
const LIST_MAX_HEIGHT = HULL_SHEET_ROW_HEIGHT * 6;

type Props = {
  candidates: RepoCandidate[];
  currentKey: string | null;
  loading: boolean;
  onSelect: (candidate: RepoCandidate) => void;
  testIDPrefix: string;
  draftContext: string;
};

/**
 * The Link list: search and repos under their owner. It only picks a repo;
 * orgs are connected from the Create owner menu or the GitHub Connect row.
 */
export function RepoList({
  candidates,
  currentKey,
  loading,
  onSelect,
  testIDPrefix,
  draftContext,
}: Props) {
  const [query, setQuery] = useTextDraft(`repo-search:${draftContext}:${testIDPrefix}`, '');
  const sections = useMemo(
    () =>
      groupRepoCandidatesByOwner(filterRepoCandidates(candidates, query)).map((group) => ({
        key: group.owner ? `owner-${group.owner.toLowerCase()}` : 'ungrouped',
        owner: group.owner,
        data: group.data,
      })),
    [candidates, query],
  );

  return (
    <YStack flexShrink={1} minHeight={0} testID={testIDPrefix}>
      <Placeheld
        input={HullDialogInput}
        accessibilityLabel="Search repos"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search repos"
        variant="sheetSearch"
        testID={`${testIDPrefix}-search`}
        value={query}
      />
      <YStack maxHeight={LIST_MAX_HEIGHT}>
        <SectionList
          initialNumToRender={6}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <EmptyState testID={`${testIDPrefix}-empty`} title={loading ? 'Loading repos…' : 'No repos match.'} />
          }
          nestedScrollEnabled
          renderItem={({ item, section }) => (
            <HullActionSheetRow
              accessibilityLabel={item.name}
              label={repoShortName(item, section.owner)}
              leading={<RepositoryMark avatarUrl={item.avatarUrl} faviconUrl={item.faviconUrl} size={28} />}
              selected={item.key === currentKey}
              onPress={() => onSelect(item)}
              testID={`${testIDPrefix}-candidate-${item.key}`}
            />
          )}
          renderSectionHeader={({ section }) =>
            section.owner ? (
              <RoomListSectionHeader
                title={section.owner ?? ''} inset="content" surface="sheet"
                testID={`${testIDPrefix}-group-${section.owner.toLowerCase()}`}
              />
            ) : null
          }
          sections={sections}
          stickySectionHeadersEnabled={false}
          testID={`${testIDPrefix}-list`}
        />
      </YStack>
    </YStack>
  );
}
