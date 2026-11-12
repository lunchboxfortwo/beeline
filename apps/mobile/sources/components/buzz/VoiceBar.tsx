import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import * as React from 'react';
import { Card, XStack, YStack, useTheme } from 'tamagui';
import { AudioLines, Mic, MicOff, Square } from 'lucide-react-native';
import { Btn, Glyph, HEIGHT, T } from '@/ui/grammar';
import { Waveform } from '@/ui/screens/composer/Waveform';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { PinGlyph } from './PinGlyph';
import { IdentityMark } from './IdentityMark';
import type { VoiceCallState } from '@/buzz/use-voice-call';

/**
 * Conversation mode's agents: one chip each. Tapping a chip pins the call to
 * that agent (today's brass pin badge on its mark); tapping it again unpins.
 */
export function VoiceAgentStrip({ voice }: { voice: VoiceCallState }) {
  const theme = useTheme() as Record<string, { val: string } | undefined>;
  const pinInk = { color: theme.canvas?.val ?? '' };
  return (
    <XStack gap="2" flexWrap="wrap" marginBottom="2" testID="conversation-target-strip">
      {voice.agents.map(agent => {
        const pinned = voice.target === agent.pubkey;
        const speaking = voice.speaker === agent.pubkey;
        return (
          <Btn key={agent.pubkey} kind="quiet" label={pinned ? `Unpin ${agent.name}` : `Speak to ${agent.name}`}
            accessibilityState={{ selected: pinned }} aria-pressed={pinned} onPress={() => voice.aim(agent.pubkey)}
            backgroundColor={pinned ? 'raised' : 'transparent'} borderRadius="md" borderWidth={1}
            borderColor={speaking ? 'needsYou' : 'transparent'} paddingHorizontal="2" gap="2"
            testID={speaking ? `voice-speaking-frame-${agent.pubkey}` : undefined}>
            <YStack position="relative">
              <IdentityMark kind="agent" seed={agent.pubkey} face={agent.face} avatarUrl={agent.avatar} name={agent.name} size={28} />
              {pinned ? (
                <YStack position="absolute" top={-6} right={-6} width={18} height={18} borderRadius="sm" backgroundColor="needsYou"
                  borderWidth={2} borderColor="canvas" alignItems="center" justifyContent="center" aria-label="Pinned" testID={`voice-pin-${agent.pubkey}`}>
                  <PinGlyph size={12} {...pinInk} />
                </YStack>
              ) : null}
            </YStack>
            <T v="meta" color={pinned ? 'ink' : 'secondary'} numberOfLines={1}>{agent.name}</T>
          </Btn>
        );
      })}
    </XStack>
  );
}

/** The call's own line: Listening or muted (a warning or error in its place), then mute and end. */
export function VoiceBar({ voice, testIDPrefix = 'chat' }: {
  voice: VoiceCallState; testIDPrefix?: string;
}) {
  const warning = voice.endingWarning ?? voice.budgetWarning;
  const speaker = voice.speaker ? voice.agents.find(a => a.pubkey === voice.speaker)?.name ?? 'Agent' : null;
  const state = speaker ? `${speaker} speaking` : voice.muted ? 'Microphone muted' : 'Listening';
  return (
    <Card backgroundColor="raised" padding="1" testID="voice-bar">
      <XStack gap="1" alignItems="center" minHeight={HEIGHT.control}>
        <XStack flex={1} minWidth={0} gap="2" alignItems="center" paddingLeft="2" aria-label={state} testID="voice-waveform">
          {voice.connecting ? <SurfaceGlyphLoader compact testID="voice-startup-loader" />
            : warning ? <T v="meta" color="needsYou" numberOfLines={1} aria-live="polite" testID="conversation-tip">{warning}</T>
              : voice.error ? <ErrorBanner inline title={voice.error} titleTestID={voice.quotaExhausted ? 'voice-quota-error' : 'voice-connection-error'} />
                : speaker ? <><Glyph icon={AudioLines} accent /><T v="meta" color="secondary" numberOfLines={1}>{state}</T></>
                  : <Waveform level={voice.level} live={!voice.muted} testID="voice-level-line" />}
        </XStack>
        <Btn kind="icon" label={voice.muted ? 'Unmute microphone' : 'Mute microphone'} onPress={() => void voice.toggleMute()}
          disabled={voice.connecting || voice.quotaExhausted} accessibilityState={{ selected: voice.muted }} testID={`${testIDPrefix}-mic`}>
          <Glyph icon={voice.muted ? MicOff : Mic} />
        </Btn>
        <Btn kind="icon" label={voice.humans > 1 ? 'Leave call' : 'End call'} onPress={() => void voice.end()} testID="voice-mic">
          <Glyph icon={Square} />
        </Btn>
      </XStack>
    </Card>
  );
}
