import { RepositoryMark } from './RepositoryMark';
import { EmptyState } from './EmptyState';
import { HullActionSheetRow } from './HullActionSheet';
import { HULL_SHEET_ROW_HEIGHT } from '@/buzz/hull-sheet-layout';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import React, { useEffect, useMemo } from 'react';
import { VirtualizedList } from 'react-native';
import { useSheetContext, YStack } from 'tamagui';
import { Placeheld } from '@/ui/grammar';
import { useTextDraft } from '@/buzz/use-text-draft';
import {
  matchesRepoQuery,
  type RepoCandidate,
} from '@/buzz/room-repo-picker';

// Six rows, then the list scrolls.
const LIST_MAX_HEIGHT = HULL_SHEET_ROW_HEIGHT * 6;

type Props<T> = {
  candidates: readonly T[];
  getCandidate: (item: T) => RepoCandidate;
  currentKey: string | null;
  loading: boolean;
  onSelect: (candidate: RepoCandidate) => void;
  testIDPrefix: string;
  draftContext: string;
};

const identityCandidate = (item: RepoCandidate) => item;

/**
 * The Link list: search and a flat repository window. It only picks a repo;
 * orgs are connected from the Create owner menu or the GitHub Connect row.
 */
export function RepoList<T = RepoCandidate>({
  candidates,
  getCandidate = identityCandidate as (item: T) => RepoCandidate,
  currentKey,
  loading,
  onSelect,
  testIDPrefix,
  draftContext,
}: Omit<Props<T>, 'getCandidate'> & Partial<Pick<Props<T>, 'getCandidate'>>) {
  const [query, setQuery] = useTextDraft(`repo-search:${draftContext}:${testIDPrefix}`, '');
  const sheet = useSheetContext();
  const bridge = sheet.scrollBridge;
  const setHasScrollView = 'setHasScrollView' in sheet ? sheet.setHasScrollView : undefined;
  // A plain list must register with the sheet so its parent does not capture
  // list swipes. Keep the list's own viewport and keyboard sizing intact.
  useEffect(() => {
    if (!bridge || !setHasScrollView) return;
    setHasScrollView(true);
    bridge.hasScrollableContent = true;
    return () => { setHasScrollView(false); bridge.y = 0; };
  }, [bridge, setHasScrollView]);
  // Opening with an empty search keeps the server array intact. Conversion is
  // owned by getItem, so only the rendered window becomes RepoCandidates.
  const data = useMemo(
    () => query.trim() ? candidates.filter(item => matchesRepoQuery(getCandidate(item), query)) : candidates,
    [candidates, getCandidate, query],
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
      <YStack
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        height={data.length ? Math.min(data.length * HULL_SHEET_ROW_HEIGHT, LIST_MAX_HEIGHT) : undefined}
      >
        <VirtualizedList<RepoCandidate>
          data={data}
          onScroll={event => { if (bridge) bridge.y = event.nativeEvent.contentOffset.y; }}
          getItem={(items: readonly T[], index: number) => getCandidate(items[index])}
          getItemCount={(items: readonly T[]) => items.length}
          keyExtractor={item => item.key}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={1}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <EmptyState testID={`${testIDPrefix}-empty`} title={loading ? 'Loading repos…' : query.trim() ? 'No repos match.' : 'No repositories connected.'} />
          }
          nestedScrollEnabled
          renderItem={({ item }) => (
            <HullActionSheetRow
              accessibilityLabel={item.name}
              label={item.name}
              wrap
              leading={<RepositoryMark avatarUrl={item.avatarUrl} faviconUrl={item.faviconUrl} size={28} />}
              selected={item.key === currentKey}
              onPress={() => onSelect(item)}
              testID={`${testIDPrefix}-candidate-${item.key}`}
            />
          )}
          testID={`${testIDPrefix}-list`}
        />
      </YStack>
    </YStack>
  );
}
