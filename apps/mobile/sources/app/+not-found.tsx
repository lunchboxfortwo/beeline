import React from 'react';
import { router } from 'expo-router';
import { YStack } from 'tamagui';
import { BeelineMark } from '@/components/buzz/BeelineMark';
import { Btn, T } from '@/ui/grammar';

export default function NotFound() {
  return (
    <YStack flex={1} backgroundColor="canvas" alignItems="center" justifyContent="center" padding="5" gap="5">
      <BeelineMark size={72} tight />
      <T v="title">Page not found</T>
      <Btn label="Back to chats" onPress={() => router.replace('/beeline/channels')}>
        Back to chats
      </Btn>
    </YStack>
  );
}
