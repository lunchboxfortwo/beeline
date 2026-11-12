import { MemberRosterRow } from './MemberRosterRow';
import React, { useRef, useState } from 'react';
import { ScrollView, XStack, YStack } from 'tamagui';
import type { MessageReactionView, RoomViewIdentity } from '@beeline/buzz-client';
import { EmojiGlyph, T } from '@/ui/grammar';
import { HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';
import { HullFloatingSurface } from './HullDialog';

function rosterSubtitle(identity: RoomViewIdentity): string {
  return [identity.handle ? `@${identity.handle.replace(/^@/, '')}` : undefined, identity.kind]
    .filter(Boolean)
    .join(' · ');
}

function ReactionMembers({
  members,
  messageId,
  sheet = false,
}: {
  members: readonly RoomViewIdentity[];
  messageId: string;
  sheet?: boolean;
}) {
  return (
    <YStack width="100%">
      {members.map((member) => (
        <MemberRosterRow
          key={member.pubkey}
          kind={member.kind}
          pubkey={member.pubkey}
          name={member.name}
          title={member.name}
          handle={member.handle}
          subtitle={rosterSubtitle(member)}
          avatarUrl={member.avatar}
          face={member.face}
          divider="bottom"
          accessibilityLabel={`${member.name}, ${rosterSubtitle(member)}`}
          testID={`reaction-member-${messageId}-${member.pubkey}`}
        />
      ))}
    </YStack>
  );
}

/**
 * A reaction keeps its quick toggle on press. Identity detail follows the
 * native input model: long press opens a bottom sheet on touch layouts, while
 * hover or keyboard focus reveals a compact popover on desktop/web.
 */
export function MessageReactionRoster({
  desktop,
  messageId,
  onReact,
  reaction,
}: {
  desktop: boolean;
  messageId: string;
  onReact(): void;
  reaction: MessageReactionView;
}) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const suppressPressUntil = useRef(0);
  const reactors = reaction.members ?? [];
  const rosterAvailable = reactors.length > 0;
  const reactionLabel = `${reaction.emoji}, ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`;
  const desktopRosterVisible = desktop && rosterAvailable && (hovered || focused);

  return (
    <YStack
      position="relative"
      {...(desktop
        ? ({
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          } as any)
        : {})}
      testID={`reaction-roster-anchor-${messageId}-${reaction.emoji}`}
    >
      <XStack
        accessibilityHint={
          rosterAvailable
            ? desktop
              ? 'Hover or focus to see who reacted'
              : 'Long press to see who reacted'
            : undefined
        }
        accessibilityLabel={reactionLabel}
        accessibilityRole="button"
        accessibilityState={{ selected: reaction.reacted }}
        hitSlop={8}
        onBlur={() => setFocused(false)}
        onFocus={() => setFocused(true)}
        onLongPress={
          !desktop && rosterAvailable
            ? () => {
                suppressPressUntil.current = Date.now() + 750;
                setSheetVisible(true);
              }
            : undefined
        }
        onPress={() => {
          if (Date.now() < suppressPressUntil.current) return;
          onReact();
        }}
        alignItems="center"
        gap="1"
        height={28}
        paddingHorizontal="2"
        borderWidth={1}
        borderColor={reaction.reacted ? 'needsYou' : 'stroke'}
        borderRadius="sm"
        backgroundColor={reaction.reacted ? 'highlight' : 'canvas'}
        testID={`reaction-chip-${messageId}-${reaction.emoji}`}
      >
        <EmojiGlyph v="body">{reaction.emoji}</EmojiGlyph>
        <T v="meta" color="secondary">{reaction.count}</T>
      </XStack>

      {desktopRosterVisible ? (
        <HullFloatingSurface
          accessibilityLabel={`${reactionLabel}. Reacted by ${reactors.map((member) => member.name).join(', ')}`}
          position="absolute"
          bottom={34}
          left={0}
          zIndex={12}
          width={232}
          paddingVertical="2"
          paddingHorizontal="4"
          testID={`reaction-popover-${messageId}-${reaction.emoji}`}
        >
          <T v="meta" color="secondary" marginBottom="1">Reacted with {reaction.emoji}</T>
          <ReactionMembers members={reactors} messageId={messageId} />
        </HullFloatingSurface>
      ) : null}

      {!desktop && sheetVisible ? (
        <HullActionSheetModal
          accessibilityLabel="Close reaction roster"
          onClose={() => setSheetVisible(false)}
          subtitle={`${reaction.count} member${reaction.count === 1 ? '' : 's'}`}
          testID={`reaction-sheet-${messageId}-${reaction.emoji}`}
          title={`Reacted with ${reaction.emoji}`}
          visible={sheetVisible}
        >
          <ScrollView maxHeight={360}>
            <ReactionMembers members={reactors} messageId={messageId} sheet />
          </ScrollView>
          <HullActionSheetCancel
            onPress={() => setSheetVisible(false)}
            testID={`reaction-sheet-close-${messageId}-${reaction.emoji}`}
          />
        </HullActionSheetModal>
      ) : null}
    </YStack>
  );
}
