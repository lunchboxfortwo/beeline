import React from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import { MESSAGE_REACTION_EMOJIS, type MessageReactionEmoji } from '@beeline/buzz-client';
import { EmojiGlyph, HEIGHT } from '@/ui/grammar';

/** The strip's cap. It scrolls, so the vocabulary may grow — it never grows
 *  past twelve choices. */
export const MAX_MESSAGE_REACTIONS = 12;

/**
 * The message actions sheet's reaction entry point: a plain horizontal
 * scrolling strip of emoji as the sheet's top cell. There is no React button
 * and nothing to expand — the emoji themselves are the whole affordance.
 */
export function MessageReactionStrip({ onReact }: { onReact(emoji: MessageReactionEmoji): void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} flexGrow={0} testID="message-reaction-strip">
      {/* The sheet's own inset on the sheet's edge. */}
      <XStack alignItems="center" gap="2" paddingHorizontal="6" paddingVertical="2">
        {MESSAGE_REACTION_EMOJIS.slice(0, MAX_MESSAGE_REACTIONS).map((emoji) => (
          <YStack
            accessibilityLabel={`React with ${emoji}`}
            accessibilityRole="button"
            key={emoji}
            onPress={() => onReact(emoji)}
            minWidth={44}
            minHeight={HEIGHT.control}
            alignItems="center"
            justifyContent="center"
            testID={`message-reaction-${emoji}`}
          >
            <EmojiGlyph v="body">{emoji}</EmojiGlyph>
          </YStack>
        ))}
      </XStack>
    </ScrollView>
  );
}
