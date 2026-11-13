import React from 'react';
import { Input, ToggleGroup, XStack, YStack } from 'tamagui';
import { ChevronDown, Plus, Search, X } from 'lucide-react-native';
import { Btn, Glyph, HEIGHT, T } from '@/ui/grammar';
import type { SearchChip } from './chat-tree-model';

export type ChatSearch = { open: boolean; query: string; chips: SearchChip[] };
export const CLOSED_SEARCH: ChatSearch = { open: false, query: '', chips: [] };

const CHIPS: { value: SearchChip; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'pinned', label: 'Pinned' },
];

/**
 * The list header (every phone tab and the desktop sidebar): the Workspace
 * name opens today's Workspace switcher, then that place's buttons. On Chats
 * and the sidebar those are Search and New chat; Search replaces the header
 * with a field and the Unread / Pinned chips.
 */
export function ChatListHeader({ workspaceName, onWorkspace, onNew, search, onSearch, actions }: {
  workspaceName: string;
  onWorkspace?: () => void;
  /** Absent when the viewer may not create a chat. */
  onNew?: () => void;
  /** Absent on tabs that do not search chats. */
  search?: ChatSearch;
  onSearch?: (next: ChatSearch) => void;
  /** A tab's own buttons, after Search and New chat. */
  actions?: React.ReactNode;
}) {
  if (search?.open && onSearch) {
    return (
      <YStack paddingHorizontal="3" paddingTop="2" paddingBottom="2" gap="2" testID="header-search">
        <XStack gap="2" alignItems="center">
          <Glyph icon={Search} />
          <Input
            flex={1}
            minWidth={0}
            size="md"
            autoFocus
            placeholder="Search chats and threads"
            aria-label="Search chats and threads"
            value={search.query}
            onChangeText={(query: string) => onSearch({ ...search, query })}
            testID="room-search-input"
          />
          <Btn kind="icon" label="Close search" onPress={() => onSearch(CLOSED_SEARCH)} testID="room-search-close"><Glyph icon={X} /></Btn>
        </XStack>
        <ToggleGroup
          type="multiple"
          value={search.chips}
          onValueChange={(chips: string[]) => onSearch({ ...search, chips: chips as SearchChip[] })}
          aria-label="Search filters"
          flexDirection="row"
          alignSelf="flex-start"
          gap="2"
          backgroundColor="transparent"
        >
          {CHIPS.map((chip) => {
            const on = search.chips.includes(chip.value);
            return (
              <ToggleGroup.Item
                key={chip.value}
                value={chip.value}
                aria-label={chip.label}
                width="auto"
                height={HEIGHT.control}
                minHeight={HEIGHT.control}
                paddingHorizontal="3"
                borderRadius="full"
                borderWidth={1}
                borderColor={on ? 'needsYou' : 'strongStroke'}
                backgroundColor={on ? 'highlight' : 'canvas'}
                testID={`room-filter-${chip.value}`}
              >
                <T v="meta" color={on ? 'needsYou' : 'secondary'}>{chip.label}</T>
              </ToggleGroup.Item>
            );
          })}
        </ToggleGroup>
      </YStack>
    );
  }
  return (
    <XStack paddingHorizontal="2" height={HEIGHT.tabBar} alignItems="center" gap="1" testID="chat-list-header">
      {onWorkspace ? (
        <Btn kind="quiet" label={`Workspace: ${workspaceName}. Switch workspace`} paddingHorizontal="2" onPress={onWorkspace} testID="workspace-switcher">
          <XStack gap="1" alignItems="center">
            <T v="heading" numberOfLines={1}>{workspaceName}</T>
            <Glyph icon={ChevronDown} size={16} />
          </XStack>
        </Btn>
      ) : (
        <YStack paddingHorizontal="2"><T v="heading" numberOfLines={1}>{workspaceName}</T></YStack>
      )}
      <YStack flex={1} />
      <XStack gap="1">
        {search && onSearch ? <Btn kind="icon" label="Search" onPress={() => onSearch({ ...search, open: true })} testID="room-search-open"><Glyph icon={Search} /></Btn> : null}
        {onNew ? <Btn kind="icon" label="New chat" onPress={onNew} testID="new-chat"><Glyph icon={Plus} /></Btn> : null}
        {actions}
      </XStack>
    </XStack>
  );
}
