import React from 'react';
import { ListItem, YStack } from 'tamagui';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { T } from '@/ui/grammar';

export function WorkAvatar({ person, size = 24 }: { person: RoomViewIdentity; size?: number }) {
  return (
    <IdentityMark
      kind={person.kind}
      seed={person.pubkey}
      name={person.name}
      face={person.face}
      avatarUrl={person.avatar}
      size={size}
    />
  );
}

export function WorkAssigneePicker({
  people,
  onPick,
}: {
  people: readonly RoomViewIdentity[];
  onPick: (person: RoomViewIdentity | null) => void;
}) {
  return (
    <YStack
      borderWidth={1}
      borderColor="strongStroke"
      borderRadius="md"
      padding="3"
      backgroundColor="raised"
      gap="1"
      testID="work-assignee-picker"
    >
      <T v="heading">Assignee</T>
      {people.map((person) => (
        <ListItem
          key={person.pubkey}
          minHeight={44}
          padding="0"
          gap="2"
          backgroundColor="transparent"
          onPress={() => onPick(person)}
          aria-label={`Assign to ${person.name}`}
        >
          <WorkAvatar person={person} />
          <T flex={1}>{person.name}</T>
        </ListItem>
      ))}
      <ListItem
        minHeight={44}
        padding="0"
        backgroundColor="transparent"
        onPress={() => onPick(null)}
        aria-label="Unassigned"
      >
        <T>Unassigned</T>
      </ListItem>
    </YStack>
  );
}
