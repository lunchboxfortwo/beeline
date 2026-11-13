import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ VirtualizedList: 'VirtualizedList', SectionList: 'SectionList' }));
vi.mock('tamagui', () => ({ YStack: 'YStack' }));
vi.mock('./RepositoryMark', () => ({ RepositoryMark: 'RepositoryMark' }));
vi.mock('./EmptyState', () => ({ EmptyState: 'EmptyState' }));
vi.mock('./HullActionSheet', () => ({ HullActionSheetRow: 'HullActionSheetRow' }));
vi.mock('./RoomListSectionHeader', () => ({ RoomListSectionHeader: 'RoomListSectionHeader' }));
vi.mock('./HullDialog', () => ({ HullDialogInput: 'HullDialogInput' }));
vi.mock('@/ui/grammar', () => ({ Placeheld: 'Placeheld' }));
vi.mock('@/buzz/use-text-draft', () => ({ useTextDraft: () => React.useState('') }));

import { RepoList } from './RepoList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This covers the data handoff to RN, not native scrolling or frame timing.
describe('Repository list data window', () => {
  it('does not inspect the full list on open and converts a distant row on demand', () => {
    const nameRead = vi.fn((index: number) => `owner/repo-${index}`);
    const candidates = Array.from({ length: 1000 }, (_, index) => ({
      key: `github:${index}`, get name() { return nameRead(index); },
    }));
    const onSelect = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<RepoList candidates={candidates} currentKey={null} loading={false}
      onSelect={onSelect} testIDPrefix="repos" draftContext="room" />); });
    expect(nameRead).not.toHaveBeenCalled();
    const list = tree!.root.findByType('VirtualizedList');
    expect(list.props.getItemCount(list.props.data)).toBe(1000);
    const item = list.props.getItem(list.props.data, 999);
    const row = list.props.renderItem({ item });
    expect(row.props.label).toBe('owner/repo-999');
    row.props.onPress();
    expect(onSelect).toHaveBeenCalledWith(candidates[999]);
    act(() => { tree!.unmount(); });
  });

  it('keeps search and selection available for repositories beyond the initial window', () => {
    const candidates = Array.from({ length: 1000 }, (_, index) => ({ key: `github:${index}`, name: `owner/repo-${index}` }));
    candidates[999].name = 'Beeline-Work/repository-selection-with-a-long-complete-name';
    const onSelect = vi.fn();
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(<RepoList candidates={candidates} currentKey="github:999" loading={false}
      onSelect={onSelect} testIDPrefix="repos" draftContext="room" />); });
    act(() => { tree!.root.findByType('Placeheld').props.onChangeText('BEELINE repository-selection'); });
    const list = tree!.root.findByType('VirtualizedList');
    expect(list.props.getItemCount(list.props.data)).toBe(1);
    const row = list.props.renderItem({ item: list.props.getItem(list.props.data, 0) });
    expect(row.props.selected).toBe(true);
    expect(row.props.label).toBe(candidates[999].name);
    expect(row.props.wrap).toBe(true);
    row.props.onPress();
    expect(onSelect).toHaveBeenCalledWith(candidates[999]);
    act(() => { tree!.unmount(); });
  });
});
