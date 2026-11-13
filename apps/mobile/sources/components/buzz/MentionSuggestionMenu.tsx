import React, { useEffect, useRef } from 'react';
import { ScrollView, YStack } from 'tamagui';
import { AlertTriangle, AtSign, Check, CornerDownRight, Hash } from 'lucide-react-native';
import { Glyph, T } from '@/ui/grammar';
import { compactRelativeTime } from '@/buzz/relative-time';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import {
  CHANNEL_MENTION_PUBKEY,
  SYSTEM_MENTION_LABEL,
  SYSTEM_MENTION_PUBKEY,
} from '@/buzz/room-participants';
import { channelCornerRoom, type ChannelSuggestion } from '@/buzz/channel-suggestions';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { memberRosterModel, memberRosterSubtitle } from '@/components/buzz/MemberRosterRow';
import type { RoomRosterParticipant } from '@/buzz/room-participants';
import { SuggestionCard, SuggestionGlyph, SuggestionRow } from '@/ui/screens/composer/Suggestions';

/** One mention row's height (`SUGGESTION_ROW_HEIGHT`); also the unit of the scroll cap. */
export const MENTION_ROW_HEIGHT = 56;

/** Keep the highlighted row inside the 3-row (keyboard open) or 6-row scroll window. */
function useHighlightedRowScroll(highlightedIndex: number, keyboardOpen: boolean) {
  const visibleRows = keyboardOpen ? 3 : 6;
  const scrollRef = useRef<{ scrollTo(options: { y: number; animated: boolean }): void } | null>(null);
  const scrollOffset = useRef(0);

  useEffect(() => {
    const top = highlightedIndex * MENTION_ROW_HEIGHT;
    const bottom = top + MENTION_ROW_HEIGHT;
    const windowHeight = visibleRows * MENTION_ROW_HEIGHT;
    let target: number | undefined;
    if (top < scrollOffset.current) target = top;
    else if (bottom > scrollOffset.current + windowHeight) target = bottom - windowHeight;
    if (target === undefined) return;
    // Record the offset now: onScroll may not fire before the next highlight change.
    scrollOffset.current = target;
    scrollRef.current?.scrollTo({ y: target, animated: false });
  }, [highlightedIndex, visibleRows]);

  return { visibleRows, scrollRef, scrollOffset };
}

/**
 * The composer's @-mention menu, headed "People and agents in #chat". Rows
 * scroll under a cap of 3 rows while the keyboard is open (so the field stays
 * above it) and 6 otherwise. As the tag menu, `checkedHandles` marks the
 * agents already tagged, and a tap toggles the tag.
 */
export function MentionSuggestionMenu({
  matches,
  overflow,
  highlightedIndex,
  keyboardOpen,
  personAvatar,
  onSelect,
  checkedHandles,
  place,
}: {
  matches: readonly RoomRosterParticipant[];
  overflow: number;
  highlightedIndex: number;
  keyboardOpen: boolean;
  personAvatar: (pubkey: string) => string | undefined;
  onSelect: (participant: RoomRosterParticipant) => void;
  checkedHandles?: ReadonlySet<string>;
  /** Where the people are: `#beeline`, or "this thread". */
  place?: string;
}) {
  const { visibleRows, scrollRef, scrollOffset } = useHighlightedRowScroll(
    highlightedIndex,
    keyboardOpen,
  );

  return (
    <SuggestionCard
      title={`People and agents in ${place ?? 'this chat'}`}
      label="Mention a chat participant"
      testID="mention-suggestions"
      overflow={overflow}
      overflowTestID="mention-suggestion-overflow"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          scrollOffset.current = event.nativeEvent.contentOffset.y;
        }}
        ref={scrollRef as never}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        maxHeight={visibleRows * MENTION_ROW_HEIGHT}
        flexShrink={1}
        testID="mention-suggestion-scroll"
      >
        {matches.map((participant, index) => {
          const selected = index === highlightedIndex;
          const checked = checkedHandles?.has(participant.handle) ?? false;
          // The two reserved rows (`@channel`, `@system`) are tokens, not
          // identities: a glyph instead of a face, and words for what they do.
          const reserved =
            participant.pubkey === CHANNEL_MENTION_PUBKEY ||
            participant.pubkey === SYSTEM_MENTION_PUBKEY;
          const display = participant.agent
            ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
            : undefined;
          // A member row reads like the roster: the agent's owner and model,
          // or the person's role.
          const subtitle = reserved
            ? undefined
            : participant.kind === 'agent'
              ? memberRosterSubtitle({ kind: 'agent', ownerHandle: participant.ownerHandle })
              : memberRosterSubtitle({ kind: 'human', role: participant.role });
          const model =
            participant.kind === 'agent' && !reserved
              ? memberRosterModel({ kind: 'agent', model: participant.model })
              : undefined;
          const detail = participant.pubkey === CHANNEL_MENTION_PUBKEY
            ? 'Everyone in this chat'
            : participant.pubkey === SYSTEM_MENTION_PUBKEY
              ? SYSTEM_MENTION_LABEL
              : [subtitle, model].filter(Boolean).join(' · ') || undefined;
          return (
            <SuggestionRow
              key={participant.pubkey}
              first={index === 0}
              selected={selected}
              label={
                participant.pubkey === SYSTEM_MENTION_PUBKEY
                  ? `${SYSTEM_MENTION_LABEL}, @${participant.handle}`
                  : !reserved
                    ? [`@${participant.handle}`, model, subtitle, participant.kind]
                        .filter(Boolean)
                        .join(', ')
                    : `${participant.name}, @${participant.handle}, ${participant.kind}`
              }
              role={checkedHandles ? 'checkbox' : 'button'}
              state={checkedHandles ? { checked } : { selected }}
              onPress={() => onSelect(participant)}
              testID={`mention-suggestion-${participant.handle}`}
              name={`@${participant.handle}`}
              nameAccent={checked}
              detail={detail}
              mark={
                reserved ? (
                  <SuggestionGlyph icon={participant.pubkey === SYSTEM_MENTION_PUBKEY ? AlertTriangle : AtSign} />
                ) : display ? (
                  <IdentityMark
                    kind="agent"
                    seed={display.avatarSeed ?? participant.pubkey}
                    avatarUrl={display.avatarUrl}
                    face={display.face}
                    name={display.name}
                    size={28}
                  />
                ) : (
                  <IdentityMark
                    kind="human"
                    seed={participant.pubkey}
                    avatarUrl={personAvatar(participant.pubkey)}
                    face={participant.face}
                    name={participant.name}
                    size={28}
                  />
                )
              }
              trailing={checked ? <Glyph icon={Check} size={16} accent /> : undefined}
            />
          );
        })}
      </ScrollView>
    </SuggestionCard>
  );
}

/**
 * The composer's `#` menu, the same card, scroll cap and row height as the
 * @-mention menu. This chat's threads lead ("Threads in #chat"), newest
 * activity on top, each with how long ago it last spoke; the other Rooms
 * follow under "Other rooms". After `#chat/` only that chat's threads remain.
 */
export function ChannelSuggestionMenu({
  query,
  matches,
  overflow,
  highlightedIndex,
  keyboardOpen,
  onSelect,
  nowMs = Date.now(),
}: {
  query: string;
  matches: readonly ChannelSuggestion[];
  overflow: number;
  highlightedIndex: number;
  keyboardOpen: boolean;
  onSelect: (suggestion: ChannelSuggestion) => void;
  nowMs?: number;
}) {
  const { visibleRows, scrollRef, scrollOffset } = useHighlightedRowScroll(
    highlightedIndex,
    keyboardOpen,
  );
  const cornerRoom = channelCornerRoom(query, matches)
    ?? (matches[0]?.kind === 'corner' ? matches[0].token.slice(0, matches[0].token.indexOf('/')) : null);
  const firstRoom = matches.findIndex((item) => item.kind === 'room');
  return (
    <SuggestionCard
      title={cornerRoom ? `Threads in #${cornerRoom}` : 'Chats'}
      label="Link a thread or chat"
      testID="channel-suggestions"
      overflow={overflow}
      overflowTestID="channel-suggestion-overflow"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          scrollOffset.current = event.nativeEvent.contentOffset.y;
        }}
        ref={scrollRef as never}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        maxHeight={visibleRows * MENTION_ROW_HEIGHT}
        flexShrink={1}
      >
        {matches.map((suggestion, index) => {
          const thread = suggestion.kind === 'corner';
          const name = thread ? suggestion.name ?? suggestion.token : `#${suggestion.token}`;
          const age = thread ? compactRelativeTime(suggestion.activityAt, nowMs) : '';
          const row = (
            <SuggestionRow
              key={suggestion.id}
              first={index === 0 || index === firstRoom}
              selected={index === highlightedIndex}
              label={[name, suggestion.subtitle, thread ? 'thread' : 'chat'].filter(Boolean).join(', ')}
              state={{ selected: index === highlightedIndex }}
              onPress={() => onSelect(suggestion)}
              testID={`channel-suggestion-${suggestion.token}`}
              name={name}
              detail={suggestion.subtitle}
              trailing={age ? <T v="meta" color="secondary">{age}</T> : undefined}
              mark={<SuggestionGlyph icon={thread ? CornerDownRight : Hash} />}
            />
          );
          return index === firstRoom && firstRoom > 0 ? (
            <React.Fragment key={suggestion.id}>
              <YStack paddingTop="2" paddingBottom="1" paddingHorizontal="1" testID="channel-suggestion-other-rooms">
                <T v="metaStrong" color="secondary">Other rooms</T>
              </YStack>
              {row}
            </React.Fragment>
          ) : row;
        })}
      </ScrollView>
    </SuggestionCard>
  );
}
