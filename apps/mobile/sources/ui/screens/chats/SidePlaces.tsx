import React from 'react';
import { ListItem, YStack } from 'tamagui';
import { AtSign, Settings, Users } from 'lucide-react-native';
import { CountPill, Glyph, HEIGHT, T } from '@/ui/grammar';

/** The desktop sidebar's places above the chats (build spec → desktop sidebar). */
export type SidePlace = { key: 'tray' | 'people' | 'settings'; label: string; icon: typeof AtSign };
export const SIDE_PLACES: SidePlace[] = [
  { key: 'tray', label: 'Tasks', icon: AtSign },
  { key: 'people', label: 'Team', icon: Users },
  { key: 'settings', label: 'Settings', icon: Settings },
];

/** Tags, People or Settings in the sidebar: the selected one takes the highlight ground and a brass edge. */
export function SidePlaceRow({ place, selected, count, onPress }: { place: SidePlace; selected: boolean; count?: number; onPress: () => void }) {
  return (
    <ListItem
      minHeight={HEIGHT.control}
      paddingHorizontal="3"
      paddingVertical="0"
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
      <Glyph icon={place.icon} accent={selected} />
      <YStack flex={1}><T v="body">{place.label}</T></YStack>
      {count ? <CountPill n={count} /> : null}
    </ListItem>
  );
}
