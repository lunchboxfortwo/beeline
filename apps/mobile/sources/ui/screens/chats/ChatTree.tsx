import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React, { useRef, useState } from 'react';
import { Collapsible, ListItem, Separator, XStack, YStack } from 'tamagui';
import { ChevronDown, ChevronUp, CornerDownRight, Pin } from 'lucide-react-native';
import equal from 'fast-deep-equal';
import { voiceDuration } from '@beeline/api-contract/phone';
import type { ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem, ChatListView } from '@beeline/buzz-client';
import { useRoomOutboxFailure } from '@/buzz/message-outbox-observer';
import { compactRelativeTime } from '@/buzz/relative-time';
import { useRoomCornerSummary } from '@/buzz/room-corner-store';
import { voiceCallHumanNames } from '@/buzz/voice-call-members';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { Btn, ChatName, Copy, Glyph, HEIGHT, StatusMark, T, useStep } from '@/ui/grammar';
import {
  VISIBLE_THREADS,
  chatPreview,
  chatTagged,
  chatThreads,
  chatTitle,
  joinableTitle,
  threadTitle,
  threadWaitsOnViewer,
  threadWord,
} from './chat-tree-model';

const MARK = 36;
/** Holding a chat's mark this long opens a new thread in it (today's corner-glyph threshold). */
export const NEW_THREAD_HOLD_MS = 450;
/** Holding the row this long toggles its pin (React Native's default long press). */
const PIN_HOLD_MS = 500;

type PressEvent = { stopPropagation?: () => void; nativeEvent?: { timestamp?: number }; timeStamp?: number };
/** When the finger touched or lifted: native touch time, or the DOM event time on web. */
const touchTime = (event?: PressEvent) => event?.nativeEvent?.timestamp ?? event?.timeStamp;

/**
 * A hold measured between the touch's own press-in and release times, so it
 * behaves the same on web (where Tamagui calls onLongPress on every click) and
 * native, and a busy JS thread that delivers both events late cannot shorten it.
 * `press` runs `onHold` for a hold and `onTap` otherwise.
 */
function useHold(ms: number, onHold: (() => void) | undefined, onTap: () => void, contain = false) {
  const pressedAt = useRef<number | undefined>(undefined);
  return {
    onPressIn: (event?: PressEvent) => {
      // The mark sits inside the row: its hold must not also start the row's.
      if (contain) event?.stopPropagation?.();
      pressedAt.current = touchTime(event);
    },
    onPress: (event?: PressEvent) => {
      const start = pressedAt.current;
      const end = touchTime(event);
      pressedAt.current = undefined;
      if (onHold && start !== undefined && end !== undefined && end - start >= ms) onHold();
      else onTap();
    },
  };
}

/** A chat's mark: the peer's identity for a direct message, the repository mark or chat glyph otherwise. */
function ChatMark({ item }: { item: Partial<Pick<ChatListItem, 'directMessage' | 'room'>> }) {
  const peer = item.directMessage?.peer;
  if (peer) {
    return peer.kind === 'agent'
      ? <IdentityMark kind="agent" seed={peer.pubkey} name={peer.name} avatarUrl={peer.avatar} face={peer.face} size={MARK} />
      : <IdentityMark kind="human" seed={peer.pubkey} name={peer.name} avatarUrl={peer.avatar} face={peer.face} size={MARK} />;
  }
  return <RepositoryMark avatarUrl={item.room?.avatar} faviconUrl={item.room?.favicon} size={MARK} />;
}

/** One active thread under its chat: ↳, the short title, and its state (brass when it waits on you). */
function ThreadLine({ item, corner, onOpen }: { item: ChatListItem; corner: ChatListCorner; onOpen: (roomId: string, cornerId: string, name: string) => void }) {
  const waiting = threadWaitsOnViewer(corner);
  const title = threadTitle(item, corner);
  const word = threadWord(corner);
  const step = useStep();
  return (
    <ListItem
      minHeight={HEIGHT.control}
      padding="0"
      paddingVertical={step('2')}
      gap={step('2')}
      alignItems="flex-start"
      justifyContent="flex-start"
      backgroundColor="transparent"
      onPress={() => onOpen(item.room.id, corner.id, corner.name)}
      aria-label={`Thread ${title}, ${word}`}
      accessibilityRole="button"
      testID={`thread-row-${corner.id}`}
    >
      <YStack paddingTop="0.5"><Glyph icon={CornerDownRight} size={16} accent={waiting} /></YStack>
      <YStack flex={1} minWidth={0} gap={step('1')}>
        <Copy>{title}</Copy>
        <Copy small accent={waiting} quiet={!waiting}>{word}</Copy>
      </YStack>
    </ListItem>
  );
}

/** "N more" expands the rest of a chat's active threads in place. */
function MoreThreads({ item, rest, onOpen }: { item: ChatListItem; rest: readonly ChatListCorner[]; onOpen: (roomId: string, cornerId: string, name: string) => void }) {
  const [shown, setShown] = useState(false);
  const title = chatTitle(item);
  return (
    <Collapsible open={shown} onOpenChange={setShown}>
      <Collapsible.Content>
        {rest.map((corner) => <ThreadLine key={corner.id} item={item} corner={corner} onOpen={onOpen} />)}
      </Collapsible.Content>
      <Collapsible.Trigger asChild>
        <ListItem
          minHeight={HEIGHT.control}
          padding="0"
          paddingVertical="2"
          gap="2"
          justifyContent="flex-start"
          backgroundColor="transparent"
          aria-expanded={shown}
          aria-label={shown ? `Show fewer threads in ${title}` : `${rest.length} more active threads in ${title}`}
          accessibilityRole="button"
          testID={`more-${item.room.id}`}
        >
          <Glyph icon={CornerDownRight} size={16} />
          <Copy small quiet>{shown ? 'Show fewer' : `${rest.length} more`}</Copy>
          <Glyph icon={shown ? ChevronUp : ChevronDown} size={14} />
        </ListItem>
      </Collapsible.Trigger>
    </Collapsible>
  );
}

type ChatRowProps = {
  item: ChatListItem;
  viewer?: string;
  now: number;
  first: boolean;
  /** The list draws the divider outside a swipeable row, so the row starts on it. */
  dividerOutside?: boolean;
  last?: boolean;
  selected?: boolean;
  pinned?: boolean;
  onOpen: (roomId: string) => void;
  onPin: (roomId: string) => void;
  onOpenThread: (roomId: string, cornerId: string, name: string) => void;
  /** Long-press of the chat's mark opens a new thread in it; absent for agents. */
  onNewThread?: (roomId: string) => void;
};

/** One chat: mark, #name, "Who: last message", age and status, then its active threads on a rail. */
export const ChatRow = React.memo(function ChatRow({ item, viewer, now, first, dividerOutside = false, last = false, selected = false, pinned = false, onOpen, onPin, onOpenThread, onNewThread }: ChatRowProps) {
  const refused = useRoomOutboxFailure(item.room.id);
  const summary = useRoomCornerSummary(item.room.id);
  const threads = chatThreads(item, summary?.openCorners ?? item.openCorners, now);
  const title = chatTitle(item);
  const preview = chatPreview(item, viewer);
  const unread = item.unread === true;
  const tagged = chatTagged(item);
  const call = item.voiceCall && !item.voiceCall.endedAt ? item.voiceCall : null;
  const age = call
    ? voiceDuration(now / 1000 - call.startedAt)
    : compactRelativeTime(item.latestMessage?.createdAt ?? item.room.updatedAt, now);
  const open = () => onOpen(item.room.id);
  const pinHold = useHold(PIN_HOLD_MS, () => onPin(item.room.id), open);
  const threadHold = useHold(NEW_THREAD_HOLD_MS, onNewThread ? () => onNewThread(item.room.id) : undefined, open, true);
  const step = useStep();
  return (
    <YStack
      paddingHorizontal="4"
      paddingTop={step('3')}
      // With the divider outside, this row also owns the gap above the next divider.
      paddingBottom={dividerOutside && !last ? step('6') : step('3')}
      testID={`chat-${item.room.id}`}
    >
      {first || dividerOutside ? null : <Separator borderColor="stroke" marginBottom={step('3')} />}
      <ListItem
        minHeight={HEIGHT.control}
        padding="0"
        paddingLeft={selected ? '2' : '0'}
        gap="3"
        alignItems="flex-start"
        justifyContent="flex-start"
        backgroundColor={selected ? 'highlight' : 'transparent'}
        borderLeftWidth={selected ? 1 : 0}
        borderColor={selected ? 'needsYou' : 'transparent'}
        onPressIn={pinHold.onPressIn}
        onPress={pinHold.onPress}
        aria-label={`Open chat ${title}${unread ? ', unread' : ''}${tagged ? ', tagged you' : ''}${pinned ? ', pinned' : ''}`}
        aria-current={selected ? 'page' : undefined}
        accessibilityRole="button"
        accessibilityHint="Long press to toggle this conversation's pin"
        testID={`room-${item.room.id}`}
      >
        {onNewThread ? (
          <YStack
            onPressIn={threadHold.onPressIn}
            onPress={threadHold.onPress}
            aria-label={`Open chat ${title}`}
            accessibilityRole="button"
            accessibilityHint="Long press to open a new thread"
            accessibilityActions={[{ name: 'longpress', label: 'New thread' }]}
            onAccessibilityAction={(event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === 'longpress') onNewThread(item.room.id);
            }}
            testID={`room-${item.room.id}-new-thread`}
          >
            <ChatMark item={item} />
          </YStack>
        ) : <ChatMark item={item} />}
        <YStack flex={1} minWidth={0} gap={step('1')}>
          <ChatName v="listTitle" name={title} testID={`room-${item.room.id}-title`} />
          {refused ? (
            <Copy small color="removed" testID={`room-${item.room.id}-preview`}>Not sent: {refused.row.text}</Copy>
          ) : call ? (
            <Copy small accent testID={`room-${item.room.id}-preview`}>Ongoing call: {voiceCallHumanNames(call, viewer)}</Copy>
          ) : (
            <Copy small quiet={!unread} testID={`room-${item.room.id}-preview`}>
              {preview.who ? <T v="metaStrong" color="secondary">{preview.who}: </T> : null}
              {preview.text}
            </Copy>
          )}
        </YStack>
        <YStack alignItems="flex-end" gap="2" paddingTop="0.5">
          <Copy small quiet testID={`room-${item.room.id}-age`}>{age}</Copy>
          <StatusMark unread={unread} tagged={tagged} />
          {pinned ? <Glyph icon={Pin} size={14} /> : null}
        </YStack>
      </ListItem>
      {threads.length ? (
        <YStack marginLeft="4" marginTop={step('2')} paddingLeft="4" borderLeftWidth={1} borderColor="strongStroke" testID={`nest-${item.room.id}`}>
          {threads.slice(0, VISIBLE_THREADS).map((corner) => <ThreadLine key={corner.id} item={item} corner={corner} onOpen={onOpenThread} />)}
          {threads.length > VISIBLE_THREADS
            ? <MoreThreads item={item} rest={threads.slice(VISIBLE_THREADS)} onOpen={onOpenThread} />
            : null}
        </YStack>
      ) : null}
    </YStack>
  );
}, (previous, next) => {
  // Server snapshots can replace unchanged DTOs; compare values, keep every callback.
  const { item: beforeItem, ...before } = previous;
  const { item: afterItem, ...after } = next;
  return equal(beforeItem, afterItem) && Object.keys(before).every((key) => before[key as keyof typeof before] === after[key as keyof typeof after]);
});

/** The divider above a chat row whose swipe must span exactly the row between dividers. */
export function ChatRowDivider({ roomId }: { roomId: string }) {
  return (
    <YStack paddingHorizontal="4" testID={`chat-divider-${roomId}`}>
      <Separator borderColor="stroke" />
    </YStack>
  );
}

/** Public chats in the Workspace the viewer has not joined, each with Join. */
export function JoinableChats({ chats, joining, onJoin }: {
  chats: NonNullable<ChatListView['joinable']>;
  joining: string | null;
  onJoin: (roomId: string, name: string) => void;
}) {
  if (!chats.length) return null;
  return (
    <YStack paddingHorizontal="4" paddingTop="3" paddingBottom="4" gap="2" testID="public-to-join">
      <Separator borderColor="stroke" marginBottom="2" />
      <T v="metaStrong" color="secondary">Public chats you can join</T>
      {chats.map((chat) => (
        <XStack key={chat.id} gap="3" alignItems="center" paddingVertical="2" testID={`joinable-${chat.id}`}>
          <ChatMark item={{}} />
          <YStack flex={1} minWidth={0}>
            <Copy>{joinableTitle(chat.name)}</Copy>
            <Copy small quiet>{chat.memberCount} {chat.memberCount === 1 ? 'member' : 'members'}</Copy>
          </YStack>
          <Btn kind="accent" label={`Join ${joinableTitle(chat.name)}`} disabled={joining !== null} onPress={() => onJoin(chat.id, chat.name)} testID={`join-${chat.id}`}>Join</Btn>
        </XStack>
      ))}
    </YStack>
  );
}
