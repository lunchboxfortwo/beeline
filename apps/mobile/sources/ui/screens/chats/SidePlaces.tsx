import React from 'react';
import { ListItem, YStack } from 'tamagui';
import { AtSign, Settings, Users } from 'lucide-react-native';
import { CountPill, Glyph, HEIGHT, T, useStep } from '@/ui/grammar';
import { useFinePointer } from '@/utils/use-fine-pointer';

/** The desktop sidebar's places above the chats (build spec → desktop sidebar). */
export type SidePlace = { key: 'tray' | 'people' | 'settings'; label: string; icon: typeof AtSign };
export const SIDE_PLACES: SidePlace[] = [
  { key: 'tray', label: 'Tasks', icon: AtSign },
  { key: 'people', label: 'Team', icon: Users },
  { key: 'settings', label: 'Settings', icon: Settings },
];

/** Tags, People or Settings in the sidebar: the selected one takes the highlight ground and a brass edge. */
export function SidePlaceRow({ place, selected, count, onPress }: { place: SidePlace; selected: boolean; count?: number; onPress: () => void }) {
  // Under a mouse the places sit at the chat rows' scale; touch keeps the 44 pt control.
  const fine = useFinePointer();
  const step = useStep();
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
      paddingHorizontal="3"
      paddingVertical={fine ? step('1') : '0'}
      gap="3"
      borderRadius="md"
      justifyContent="flex-start"
      backgroundColor={selected ? 'highlight' : 'transparent'}
      borderLeftWidth={1}
      borderColor={selected ? 'needsYou' : 'transparent'}
      onPress={onPress}
      aria-label={place.label}
      aria-current={selected ? 'page' : undefined}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={`side-${place.key}`}
    >
      <Glyph icon={place.icon} size={fine ? 16 : 20} accent={selected} />
      <YStack flex={1}><T v={fine ? 'meta' : 'body'}>{place.label}</T></YStack>
      {count ? <CountPill n={count} /> : null}
    </ListItem>
  );
}
