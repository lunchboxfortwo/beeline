import React from 'react';
import { ListItem, XStack, YStack } from 'tamagui';
import { AtSign, Settings, Users } from 'lucide-react-native';
import { CountPill, Glyph, HEIGHT, T } from '@/ui/grammar';
import { useFinePointer } from '@/utils/use-fine-pointer';

/** The desktop sidebar's places above the chats (build spec → desktop sidebar). */
export type SidePlace = { key: 'tray' | 'people' | 'settings'; label: string; icon: typeof AtSign };
export const SIDE_PLACES: SidePlace[] = [
  { key: 'tray', label: 'Tasks', icon: AtSign },
  { key: 'people', label: 'Team', icon: Users },
  { key: 'settings', label: 'Settings', icon: Settings },
];

/** Tasks, Team or Settings in the sidebar: shared rail gutter, readable body type, and rounded selection pill. */
export function SidePlaceRow({ place, selected, count, onPress }: { place: SidePlace; selected: boolean; count?: number; onPress: () => void }) {
  // Under a mouse the places sit at the chat rows' scale; touch keeps the 44 pt control.
  const fine = useFinePointer();
  return (
    // ListItem renders a list item and drops accessibilityRole on web; the role,
    // tab stop and Enter/Space make the row a button keyboard users can reach and press.
    <ListItem
      role="button"
      tabIndex={0}
      onKeyDown={(event: { key: string; preventDefault: () => void }) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPress();
      }}
      minHeight={fine ? undefined : HEIGHT.control}
      paddingHorizontal="2"
      paddingVertical={fine ? '1' : '0'}
      gap="2"
      borderRadius="md"
      justifyContent="flex-start"
      backgroundColor={selected ? 'highlight' : 'transparent'}
      onPress={onPress}
      aria-label={place.label}
      aria-current={selected ? 'page' : undefined}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={`side-${place.key}`}
    >
      <XStack width={20} height={20} alignItems="center" justifyContent="center" flexShrink={0}>
        <Glyph icon={place.icon} size={18} color={selected ? 'ink' : undefined} />
      </XStack>
      <YStack flex={1} minWidth={0}>
        <T v={selected ? 'heading' : 'body'} color={selected ? 'ink' : 'secondary'} numberOfLines={1}>{place.label}</T>
      </YStack>
      {count ? <CountPill n={count} /> : null}
    </ListItem>
  );
}
