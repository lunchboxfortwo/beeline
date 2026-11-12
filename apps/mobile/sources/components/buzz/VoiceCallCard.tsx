import { Button } from '@/components/buzz/Button';
import { voiceCallHumanNames } from '@/buzz/voice-call-members';
import * as React from 'react';
import { XStack, YStack } from 'tamagui';
import { HEIGHT, T } from '@/ui/grammar';
import { type VoiceCall, voiceDuration } from '@beeline/api-contract/phone';

/** The running call occupies its own row below the Room header. */
export function VoiceCallCard({ call, joined, onJoin, connecting = false, viewer }: {
  call: VoiceCall; joined: boolean; onJoin(): void; connecting?: boolean; viewer?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now() / 1000);
  React.useEffect(() => {
    if (call.endedAt) return;
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [call.endedAt]);
  if (call.endedAt) return null;
  return (
    <YStack paddingHorizontal="4" paddingVertical="2" testID="voice-call-header">
      <XStack minHeight={HEIGHT.control} alignItems="center" paddingHorizontal="4" gap="2"
        borderWidth={1} borderRadius="md" borderColor="stroke" backgroundColor="raised">
        <YStack width={8} height={8} borderRadius="full" backgroundColor="needsYou" />
        <T v="meta" color="ink" flex={1} numberOfLines={1}>Call · {voiceDuration(now - call.startedAt)} · {voiceCallHumanNames(call, viewer)}</T>
        {!joined && (
          <Button
            onPress={onJoin}
            disabled={connecting}
            hitSlop={8}
            accessibilityState={{ busy: connecting }}
            accessibilityRole="button"
            accessibilityLabel="Join call"
            testID="voice-call-join"
            label={connecting ? 'Joining…' : 'Join'}
            variant="primary"
            loading={connecting}
          />
        )}
      </XStack>
    </YStack>
  );
}
