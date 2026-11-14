import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import React, { useState } from 'react';
import { XStack } from 'tamagui';
import { Square } from 'lucide-react-native';
import { T, Btn, Glyph } from '@/ui/grammar';

/** The existing workflow section header. */
export function DetailSection({ title, testID }: { title: string; testID?: string }) {
  return (
    <XStack
      marginTop="2"
      paddingHorizontal="4"
      alignItems="center"
      justifyContent="space-between"
      borderBottomWidth={1}
      borderBottomColor="stroke"
      testID={testID}
    >
      <RoomListSectionHeader title={title} inset="content" spacing="flush"/>
    </XStack>
  );
}

/**
 * "Stop schedule" or "Stop subscription": one tap asks, a second confirms, the
 * existing confirmation flow in the profile action position.
 */
export function StopScheduledWork({
  label,
  onStop,
  working,
  testID,
}: {
  label: string;
  onStop: () => void;
  working: boolean;
  testID: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return <XStack gap="2" alignItems="center">
    <Btn kind="destructive" label={confirming ? `Confirm ${label.toLowerCase()}` : label}
      disabled={working} onPress={confirming ? onStop : () => setConfirming(true)}
      testID={confirming ? `${testID}-confirm` : testID}>
      <XStack gap="2" alignItems="center"><Glyph icon={Square} size={16} color="removed" /><T v="heading" color="removed">{label}</T></XStack>
    </Btn>
    {confirming ? <Btn kind="quiet" label="Cancel" disabled={working}
      onPress={() => setConfirming(false)} testID={`${testID}-cancel`}>Cancel</Btn> : null}
  </XStack>;
}
