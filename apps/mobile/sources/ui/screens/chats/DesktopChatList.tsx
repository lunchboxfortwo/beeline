import React, { useState } from 'react';
import equal from 'fast-deep-equal';
import { ListItem, XStack, YStack } from 'tamagui';
import { ChevronDown, ChevronUp, CornerDownRight, Hash, Pin } from 'lucide-react-native';
import type { ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { compactRelativeTime } from '@/buzz/relative-time';
import { roomRowName } from '@/buzz/room-list-row';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import { AtMark, Glyph, HEIGHT, MARK, StatusMark, T, typeStyle, useStep, useTextSize } from '@/ui/grammar';
import { threadWaitsOnViewer } from '@/ui/screens/thread/thread-status';
import { useFinePointer } from '@/utils/use-fine-pointer';
import { NEW_THREAD_HOLD_MS, PIN_HOLD_MS, useHold } from './ChatTree';
import { chatTagged, chatTitle, threadTitle } from './chat-tree-model';

/** Rows each section shows before its "Show all N" row; Waiting on you is never capped. */
export const SECTION_CAP = { chats: 8, dms: 5 } as const;
/** The lead column: a chat's # glyph or a direct message's face. */
const LEAD = 20;
/** The trailing state column, the same column as every state mark: needs you, unread, a section's count. */
const TRAIL = MARK;

type Props = {
  chats: readonly ChatListItem[];
  now: number;
  viewer?: string;
  selected: string | null;
  pinned: readonly string[];
  /** Each chat's open threads from the corner store, falling back to the list's own. */
  corners: (item: ChatListItem) => readonly ChatListCorner[] | undefined;
  onOpen: (roomId: string) => void;
  onPin: (roomId: string) => void;
  onOpenThread: (roomId: string, cornerId: string, name: string) => void;
  onNewThread?: (roomId: string) => void;
};

const age = (seconds: number | undefined, now: number) => compactRelativeTime(seconds, now);
const chatAge = (item: ChatListItem, now: number) => age(item.latestMessage?.createdAt ?? item.room.updatedAt, now);

/** The row's state mark, or its empty column. */
function Dot({ unread, tagged }: { unread: boolean; tagged: boolean }) {
  return (
    <YStack width={TRAIL} height={TRAIL} flexShrink={0} alignItems="center" justifyContent="center">
      <StatusMark unread={unread} tagged={tagged} />
    </YStack>
  );
}

/**
 * One list row. A fine pointer takes the row's natural height; touch keeps
 * the 44 pt control height. The open chat takes the highlight and its brass edge.
 */
function Row({ selected = false, twoLine = false, label, onPressIn, onPress, testID, children }: {
  selected?: boolean; twoLine?: boolean; label: string; testID: string; children: React.ReactNode;
  onPressIn?: (event?: any) => void; onPress: (event?: any) => void;
}) {
  const step = useStep();
  const fine = useFinePointer();
  return (
    // ListItem renders a list item and drops accessibilityRole on web; the role,
    // tab stop and Enter/Space make the row a button keyboard users can reach and press.
    <ListItem
      role="button"
      tabIndex={0}
      onKeyDown={(event: { key: string; preventDefault: () => void }) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPress();
      }}
      minHeight={fine ? undefined : HEIGHT.control}
      padding="0"
      paddingLeft={step('5')}
      paddingRight={step('6')}
      paddingVertical={twoLine ? step('1') : fine ? step('1') : '0'}
      gap={step('2')}
      alignItems={twoLine ? 'flex-start' : 'center'}
      justifyContent="flex-start"
      backgroundColor={selected ? 'highlight' : 'transparent'}
      borderRadius={0}
      borderLeftWidth={1}
      borderColor={selected ? 'needsYou' : 'transparent'}
      onPressIn={onPressIn}
      onPress={onPress}
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
      accessibilityRole="button"
      testID={testID}
    >
      {children}
    </ListItem>
  );
}

/** A section's quiet label and count, on the rows' left edge; a hairline above all but the first. */
function SectionLabel({ title, count, rule }: { title: string; count: number; rule: boolean }) {
  const step = useStep();
  return (
    <XStack borderTopWidth={rule ? 1 : 0} borderColor="stroke" marginTop={rule ? step('2') : '0'}
      paddingLeft={step('5')} paddingRight={step('6')} paddingTop={step('3')} paddingBottom={step('1')} gap={step('2')} alignItems="center">
      <T v="meta" color="secondary" flex={1}>{title}</T>
      <XStack minWidth={TRAIL} justifyContent="center"><T v="meta" color="secondary">{String(count)}</T></XStack>
    </XStack>
  );
}

/** A thread that waits on the viewer: its title and age, then why and where. */
function WaitingRow({ item, corner, now, onOpenThread }: {
  item: ChatListItem; corner: ChatListCorner; now: number; onOpenThread: Props['onOpenThread'];
}) {
  const title = threadTitle(item, corner);
  const where = corner.reason ? `${corner.reason} · ${chatTitle(item)}` : chatTitle(item);
  // ↳ and the mark centre on the title's line.
  const line = typeStyle('metaStrong', useTextSize()).lineHeight;
  return (
    <Row twoLine label={`Thread ${title} in ${chatTitle(item)}, waiting on you`}
      onPress={() => onOpenThread(item.room.id, corner.id, corner.name)} testID={`thread-row-${corner.id}`}>
      <XStack width={LEAD} height={line} alignItems="center" justifyContent="center"><Glyph icon={CornerDownRight} size={16} /></XStack>
      <YStack flex={1} minWidth={0}>
        <XStack gap="2" alignItems="center">
          <T v="metaStrong" color="ink" flex={1} numberOfLines={1}>{title}</T>
          <T v="meta" color="secondary">{age(corner.waitingSince ?? corner.lastActivityAt ?? item.room.updatedAt, now)}</T>
        </XStack>
        <T v="meta" color="secondary" numberOfLines={1}>{where}</T>
      </YStack>
      <XStack width={TRAIL} height={line} alignItems="center" justifyContent="center"><AtMark /></XStack>
    </Row>
  );
}

type ChatLineProps = {
  item: ChatListItem; now: number; selected: boolean; pinned: boolean;
  onOpen: Props['onOpen']; onPin: Props['onPin']; onNewThread: Props['onNewThread'];
};

/** One chat on one line: its repository picture, # or face, name (semibold when unread), pin, age, dot. */
const ChatLine = React.memo(function ChatLine({ item, now, selected, pinned, onOpen, onPin, onNewThread }: ChatLineProps) {
  const unread = item.unread === true;
  const tagged = chatTagged(item);
  const title = chatTitle(item);
  const peer = item.directMessage?.peer;
  const open = () => onOpen(item.room.id);
  const pinHold = useHold(PIN_HOLD_MS, () => onPin(item.room.id), open);
  const threadHold = useHold(NEW_THREAD_HOLD_MS, onNewThread ? () => onNewThread(item.room.id) : undefined, open, true);
  return (
    <Row selected={selected} onPressIn={pinHold.onPressIn} onPress={pinHold.onPress}
      label={`Open chat ${title}${unread ? ', unread' : ''}${tagged ? ', tagged you' : ''}${pinned ? ', pinned' : ''}`}
      testID={`room-${item.room.id}`}>
      <XStack width={LEAD} height={LEAD} alignItems="center" justifyContent="center" flexShrink={0}
        {...(onNewThread ? { onPressIn: threadHold.onPressIn, onPress: threadHold.onPress, testID: `room-${item.room.id}-new-thread` } : {})}>
        {peer ? (
          peer.kind === 'agent'
            ? <IdentityMark kind="agent" seed={peer.pubkey} name={peer.name} avatarUrl={peer.avatar} face={peer.face} size={LEAD} />
            : <IdentityMark kind="human" seed={peer.pubkey} name={peer.name} avatarUrl={peer.avatar} face={peer.face} size={LEAD} />
        ) : item.room.homepageIcon || item.room.avatar || item.room.favicon
          ? <RepositoryMark homepageIconUrl={item.room.homepageIcon} avatarUrl={item.room.avatar} faviconUrl={item.room.favicon} size={LEAD} />
          : <Glyph icon={Hash} size={16} />}
      </XStack>
      <T v={unread ? 'metaStrong' : 'meta'} color={unread ? 'ink' : 'secondary'} flex={1} numberOfLines={1}
        testID={`room-${item.room.id}-title`}>{roomRowName(item).name}</T>
      {pinned ? <Glyph icon={Pin} size={14} /> : null}
      <T v="meta" color="secondary" testID={`room-${item.room.id}-age`}>{chatAge(item, now)}</T>
      <Dot unread={unread} tagged={tagged} />
    </Row>
  );
}, (previous, next) => {
  // Server snapshots can replace unchanged DTOs; compare values, keep every callback.
  const { item: beforeItem, ...before } = previous;
  const { item: afterItem, ...after } = next;
  return equal(beforeItem, afterItem) &&
    (Object.keys(before) as (keyof typeof before)[]).every((key) => before[key] === after[key]);
});

/** Pinned first, then the server's recency order; the open chat never hides behind the cap. */
function CappedSection({ title, items, cap, rule, props }: {
  title: string; items: readonly ChatListItem[]; cap: number; rule: boolean; props: Props;
}) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const ordered = [
    ...items.filter((item) => props.pinned.includes(item.room.id)),
    ...items.filter((item) => !props.pinned.includes(item.room.id)),
  ];
  const capped = ordered.filter((item, index) => index < cap || item.room.id === props.selected);
  const hidden = ordered.filter((item) => !capped.includes(item));
  const hiddenUnread = hidden.some((item) => item.unread === true);
  const hiddenTagged = hidden.some(chatTagged);
  return (
    <YStack testID={`section-${title}`}>
      <SectionLabel title={title} count={items.length} rule={rule} />
      {(all ? ordered : capped).map((item) => (
        <ChatLine key={item.room.id} item={item} now={props.now} selected={props.selected === item.room.id}
          pinned={props.pinned.includes(item.room.id)} onOpen={props.onOpen} onPin={props.onPin} onNewThread={props.onNewThread} />
      ))}
      {hidden.length ? (
        <Row onPress={() => setAll(!all)} testID={`show-all-${title}`}
          label={all ? `Show fewer ${title.toLowerCase()}` : `Show all ${ordered.length} ${title.toLowerCase()}${hiddenTagged ? ', tagged you' : hiddenUnread ? ', unread' : ''}`}>
          <XStack width={LEAD} alignItems="center" justifyContent="center"><Glyph icon={all ? ChevronUp : ChevronDown} size={14} /></XStack>
          <T v="meta" color="secondary" flex={1}>{all ? 'Show fewer' : `Show all ${ordered.length}`}</T>
          {all ? <XStack width={TRAIL} /> : <Dot unread={hiddenUnread} tagged={hiddenTagged} />}
        </Row>
      ) : null}
    </YStack>
  );
}

/**
 * The desktop sidebar's chats in three sections: the threads waiting on the
 * viewer (uncapped), then Chats and Direct messages as one-line rows.
 */
export function DesktopChatList(props: Props) {
  const waiting = props.chats.flatMap((item) => item.directMessage ? [] : (props.corners(item) ?? [])
    .filter((corner) => threadWaitsOnViewer(corner, props.viewer)).map((corner) => ({ item, corner })));
  const chats = props.chats.filter((item) => !item.directMessage);
  const dms = props.chats.filter((item) => item.directMessage);
  return (
    <YStack paddingBottom="2" testID="desktop-chat-sections">
      {waiting.length ? (
        <YStack testID="section-Waiting on you">
          <SectionLabel title="Waiting on you" count={waiting.length} rule={false} />
          {waiting.map(({ item, corner }) => (
            <WaitingRow key={corner.id} item={item} corner={corner} now={props.now} onOpenThread={props.onOpenThread} />
          ))}
        </YStack>
      ) : null}
      <CappedSection title="Chats" items={chats} cap={SECTION_CAP.chats} rule={waiting.length > 0} props={props} />
      <CappedSection title="Direct messages" items={dms} cap={SECTION_CAP.dms} rule={waiting.length > 0 || chats.length > 0} props={props} />
    </YStack>
  );
}
