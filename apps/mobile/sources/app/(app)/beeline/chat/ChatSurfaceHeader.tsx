import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React from 'react';
import type { View } from 'react-native';
import { ListItem, XStack, YStack } from 'tamagui';
import { ArrowLeft, MoreHorizontal, Settings } from 'lucide-react-native';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { Btn, ChatMark, ChatName, Glyph, PlaceHeader, SafeTop, T } from '@/ui/grammar';
import { ThreadBar, type ThreadHeaderData } from '@/ui/screens/thread/ThreadHeader';

export type DirectMessagePeerMark = {
  kind: 'agent' | 'human';
  seed: string;
  avatarUrl?: string;
  face?: string;
};

type Props = {
  isCorner: boolean;
  isDirectMessage: boolean;
  /** Phone only: a desktop chat sits beside the sidebar and has no Back. */
  showBack: boolean;
  handleBack: () => void;
  /** `#beeline` or `@handle`; null while the name has not landed. */
  title: string | null;
  memberCount: number;
  repositoryAvatar?: string;
  repositoryFavicon?: string;
  openChatInfo: () => void;
  openMembers: () => void;
  /** A DM's peer, when its mark should show. */
  dmPeer?: DirectMessagePeerMark;
  dmHeaderPresence: string;
  openDmActions?: () => void;
  thread?: ThreadHeaderData;
  threadCollapsed: boolean;
  openParentChat: () => void;
  /** The full thread header under the bar, while the title block is away. */
  threadExpanded?: React.ReactNode;
  expandThread?: () => void;
  openCornerActions?: () => void;
  threadBarRef?: React.Ref<View>;
  onThreadBarLayout?: () => void;
};

export { ChatMark };

function TitleSkeleton() {
  return <YStack width={120} height={24} borderRadius="sm" backgroundColor="highlight" aria-label="Loading name" testID="chat-title-skeleton" />;
}

/** The header over a chat whose first read failed: Back (phone) and the name, then the error line. */
export function ChatSurfaceErrorHeader({ title, showBack, handleBack, error }: {
  title: string; showBack: boolean; handleBack: () => void; error: string | null;
}) {
  return (
    <YStack flex={1} backgroundColor="canvas" testID="room-hydration-error">
      <SafeTop />
      <XStack paddingHorizontal="3" paddingTop="3" paddingBottom="2" gap="2" alignItems="center">
        {showBack ? <Btn kind="icon" label="Back" onPress={handleBack} testID="chat-back"><Glyph icon={ArrowLeft} /></Btn> : null}
        <T v="title" flex={1}>{title}</T>
      </XStack>
      {error ? <YStack paddingHorizontal="4" paddingVertical="3"><T v="body" color="secondary" testID="room-read-error">{error}</T></YStack> : null}
    </YStack>
  );
}

/**
 * A chat: #name (opens chat info), a plain "N members" under it (opens
 * Members) and ⚙ (opens chat info), beside its repository mark. A thread is
 * header B (`ThreadBar`); a DM names its peer.
 */
export const ChatSurfaceHeaderView = React.memo(function ChatSurfaceHeaderView({
  isCorner,
  isDirectMessage,
  showBack,
  handleBack,
  title,
  memberCount,
  repositoryAvatar,
  repositoryFavicon,
  openChatInfo,
  openMembers,
  dmPeer,
  dmHeaderPresence,
  openDmActions,
  thread,
  threadCollapsed,
  openParentChat,
  threadExpanded,
  expandThread,
  openCornerActions,
  threadBarRef,
  onThreadBarLayout,
}: Props) {
  if (isCorner && thread) {
    return (
      <ThreadBar h={thread} collapsed={threadCollapsed} expanded={threadExpanded} back={handleBack} openChat={openParentChat}
        expand={expandThread} openActions={openCornerActions} barRef={threadBarRef} onBarLayout={onThreadBarLayout} />
    );
  }
  const name = title === null ? <TitleSkeleton /> : isDirectMessage ? (
    <T v="title" testID="chat-title">{title}</T>
  ) : (
    <ListItem padding="0" minHeight={0} justifyContent="flex-start" backgroundColor="transparent"
      onPress={openChatInfo} aria-label={`Chat info: ${title}`} accessibilityRole="button" testID="chat-title-link">
      <ChatName name={title} testID="chat-title" />
    </ListItem>
  );
  const meta = isDirectMessage ? (
    dmHeaderPresence ? <T v="meta" color="secondary" numberOfLines={1} testID="room-header-meta">{dmHeaderPresence}</T> : null
  ) : (
    <ListItem padding="0" paddingVertical="1" minHeight={0} alignSelf="flex-start" width="auto" justifyContent="flex-start"
      backgroundColor="transparent" onPress={openMembers}
      aria-label={`${memberCount} members: open Members`} accessibilityRole="button" testID="chat-members-link">
      <T v="meta" color="secondary">{memberCount === 1 ? '1 member' : `${memberCount} members`}</T>
    </ListItem>
  );
  const right = isDirectMessage ? (
    openDmActions ? (
      <Btn kind="icon" label="Conversation actions" onPress={openDmActions} testID="dm-actions-menu">
        <Glyph icon={MoreHorizontal} />
      </Btn>
    ) : null
  ) : (
    <Btn kind="icon" label="Chat settings" onPress={openChatInfo} testID="chat-settings">
      <Glyph icon={Settings} />
    </Btn>
  );
  return (
    <PlaceHeader
      testID="chat-header"
      back={showBack ? handleBack : undefined}
      backTestID="chat-back"
      mark={isDirectMessage
        ? dmPeer ? <IdentityMark kind={dmPeer.kind} seed={dmPeer.seed} avatarUrl={dmPeer.avatarUrl} face={dmPeer.face} name={title ?? ''} size={36} /> : null
        : <RepositoryMark avatarUrl={repositoryAvatar} faviconUrl={repositoryFavicon} size={36} />}
      title={name}
      meta={meta}
      right={right}
    />
  );
});
