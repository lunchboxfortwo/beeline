import type { MessageSendState } from '@/buzz/message-outbox';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, type View } from 'react-native';
import { XStack, YStack } from 'tamagui';
import TranscriptSwipeable, { type TranscriptSwipeableMethods as SwipeableMethods } from '@/components/buzz/TranscriptSwipeable';
import { DesktopMessageAction } from '@/components/buzz/DesktopMessageAction';
import { ButtonRowFrame } from '@/components/buzz/ButtonRow';
import { DesktopWorkspacePortal } from '@/components/buzz/DesktopWorkspacePortal';
import { MESSAGE_REACTION_EMOJIS, type AttachmentReference, type MessageReactionEmoji } from '@beeline/buzz-client';
import type { AgentPresentation, ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { ChannelReferenceIndex, ChannelReferenceTarget } from '@/buzz/channel-reference';
import { type MessageReplyDisplayTarget } from '@/buzz/message-reply';
import { currentViewerConversation, subscribeViewerConversation, viewerContextLabel } from '@/buzz/viewer-conversation';
import { type ConnectorReceipt } from '@/buzz/connector-receipt';
import { formatAttachmentSize } from '@/buzz/chat-attachment';
import { TranscriptReference } from '@/components/buzz/TranscriptReference';
import { openComputerSessionViewer } from '@/components/buzz/ComputerSession';
import { openArtifactViewer } from '@/components/buzz/ArtifactCard';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { FileRow } from '@/ui/screens/transcript/FileRow';
import { CornerDownRight, CornerUpLeft } from 'lucide-react-native';
import { EmojiGlyph, Glyph, RingOutset, T } from '@/ui/grammar';



/**
 * Attachment bytes are kept for 24 hours (`apps/server/src/media-ttl.ts`); the
 * message that carried them is kept forever. Past the window the server marks
 * the attachment `expired`, and the row says so in the same metrics as a live
 * one — the name, type and size the message still holds, inscribed rather than
 * framed. Nothing is fetched and nothing opens: there is no longer a file
 * behind the link, and a broken thumbnail or a spinner would say otherwise.
 * Every live file renders the artifact card instead, so a posted file has one
 * shape from send through every later refresh.
 */
export function ExpiredAttachmentRow({ attachment }: { attachment: AttachmentReference }) {
  const metadata = `${attachment.mimeType.toUpperCase()} · ${formatAttachmentSize(attachment.size)}`;
  return (
    <YStack
      accessibilityLabel={`Expired attachment ${attachment.name}`}
      minWidth={0}
      width="100%"
      marginTop="2"
      testID={`chat-attachment-expired-${attachment.name}`}
    >
      <FileRow name={attachment.name} meta={`EXPIRED · ${metadata}`} opens={false} quiet />
    </YStack>
  );
}


/**
 * A swipe panel behind a message: the action's glyph beside its name, on the
 * raised surface, edged on the message's side. Glyph and name sit on one line so
 * a one-line message row holds them. The swipeable owns a fixed action distance,
 * so unopened panels do not need to mount their labels or glyphs.
 */
function SwipeAction({ side, icon, label, accessibilityLabel, shown, testID }: {
  side: 'left' | 'right'; icon: React.ComponentProps<typeof Glyph>['icon']; label: string; accessibilityLabel: string; shown: boolean; testID: string;
}) {
  return (
    <XStack
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      paddingHorizontal="3"
      marginBottom="2"
      gap="1"
      alignItems="center"
      justifyContent="center"
      backgroundColor="raised"
      borderColor="stroke"
      borderLeftWidth={side === 'right' ? 1 : 0}
      borderRightWidth={side === 'left' ? 1 : 0}
      opacity={shown ? 1 : 0}
      testID={testID}
    >
      <Glyph icon={icon} size={16} accent />
      <T v="meta" color="secondary" numberOfLines={1}>{label}</T>
    </XStack>
  );
}

export function SwipeToReply({
  children,
  messageId,
  onLongPress,
  onActions,
  onPress,
  onReply,
  onReact,
  onForward,
  onBookmark = () => undefined,
  onReportIssue,
  onSwipeThread,
  bookmarked = false,
  isDesktop,
  replyOnly = false,
}: {
  children: React.ReactNode;
  messageId: string;
  onLongPress(): void;
  /** Mobile long press — opens the message actions sheet. Desktop long press
   *  keeps its copy shortcut and reaches the same sheet through its buttons. */
  onActions?(): void;
  onPress?(): void;
  onReply?(): void;
  onReact(emoji: MessageReactionEmoji): void;
  onForward(): void;
  onBookmark?(): void;
  /** Report issue — files the message with the Beeline feedback loop. Omitted
   *  where the row offers no report (the desktop work pane's read-only copy). */
  onReportIssue?(): void;
  /** Mobile swipe right — open a new thread from the message. */
  onSwipeThread?(): void;
  bookmarked?: boolean;
  isDesktop: boolean;
  replyOnly?: boolean;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const [swipeShown, setSwipeShown] = useState(false);
  const showSwipe = useCallback(() => setSwipeShown(true), []);
  const hideSwipe = useCallback(() => setSwipeShown(false), []);
  useEffect(() => setSwipeShown(false), [messageId]);
  const commitSwipe = (direction: 'left' | 'right') => {
    // TranscriptSwipeable reports the movement direction. Its UI-thread spring
    // can return immediately without the legacy native-driver close timers.
    swipeableRef.current?.close();
    // Install the quote before a composer update can recycle this row.
    if (direction === 'left') onReply?.();
    else onSwipeThread?.();
  };
  const [desktopActionsVisible, setDesktopActionsVisible] = useState(false);
  const [desktopRowHovered, setDesktopRowHovered] = useState(false);
  const [reactionPickerVisible, setReactionPickerVisible] = useState(false);
  const actionsRef = useRef<View>(null);
  const pickerRef = useRef<View>(null);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => setReactionPickerVisible(false), [messageId, isDesktop]);
  useLayoutEffect(() => {
    if (!isDesktop || !reactionPickerVisible || Platform.OS !== 'web') {
      setPickerPosition(null);
      return;
    }
    // RN Web rows create stacking contexts. A row-local zIndex cannot clear
    // later messages, and the transcript clips anything below its bottom edge.
    // Measure the real surface in the body portal, then keep it in the viewport.
    const anchor = actionsRef.current as unknown as HTMLElement;
    const picker = pickerRef.current as unknown as HTMLElement;
    if (!anchor || !picker) return;
    const bounds = anchor.getBoundingClientRect();
    const size = picker.getBoundingClientRect();
    const inset = 8;
    const maxTop = Math.max(inset, window.innerHeight - size.height - inset);
    setPickerPosition({
      top: Math.max(inset, Math.min(
        bounds.bottom + size.height <= window.innerHeight - inset
          ? bounds.bottom
          : bounds.top - size.height,
        maxTop,
      )),
      left: Math.max(inset, Math.min(bounds.right - size.width, window.innerWidth - size.width - inset)),
    });
    const dismiss = () => setReactionPickerVisible(false);
    const outside = (event: PointerEvent) => {
      if (!picker.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    // A scrolled/replaced row must never leave a picker pointing at old content.
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [isDesktop, messageId, reactionPickerVisible]);
  const message = isDesktop ? (
    <YStack flex={1} minWidth={0}>
      <ContentTarget
        accessibilityHint="Long press to copy the entire message"
        accessibilityLabel="Message"
        onLongPress={onLongPress}
        onPress={onPress}
        testID={`copy-message-${messageId}`}
      >
        {children}
      </ContentTarget>
    </YStack>
  ) : (
    <ContentTarget
      // The long press is the row's action sheet — reactions, copy, reply,
      // forward — so it deliberately claims what native text selection once
      // held on this row; Copy on the sheet is the way to the full text now.
      // A normal press opens unsent-message actions or dismisses the composer.
      onLongPress={onActions}
      onPress={onPress}
      testID={`copy-message-${messageId}`}
    >
      {children}
    </ContentTarget>
  );
  if (isDesktop) {
    return (
      <XStack
        position="relative"
        alignItems="flex-start"
        {...({
          onMouseEnter: () => setDesktopRowHovered(true),
          onMouseLeave: () => setDesktopRowHovered(false),
        } as any)}
      >
        {message}
        <ButtonRowFrame
          ref={actionsRef}
          accessibilityLabel="Message actions"
          position="absolute"
          top={0}
          right={0}
          flexDirection="row"
          opacity={desktopActionsVisible || desktopRowHovered || reactionPickerVisible ? 1 : 0}
          borderWidth={1}
          borderColor="strongStroke"
          borderRadius="sm"
          backgroundColor="canvas"
          testID={`message-actions-${messageId}`}
        >
          {!replyOnly ? (
            <DesktopMessageAction action="copy" label="Copy message text" tooltip="Copy" onPress={onLongPress} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`copy-button-${messageId}`} />
          ) : null}
          {onReply ? <DesktopMessageAction action="reply" label="Reply to message" tooltip="Reply" onPress={onReply} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`reply-button-${messageId}`} /> : null}
          {!replyOnly ? (
            <>
              <DesktopMessageAction action="react" label="React to message" tooltip="React" onPress={() => setReactionPickerVisible((visible) => !visible)} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`react-button-${messageId}`} />
              <DesktopMessageAction action="bookmark" label={bookmarked ? 'Remove bookmark' : 'Bookmark message'} tooltip={bookmarked ? 'Remove bookmark' : 'Bookmark'} selected={bookmarked} onPress={onBookmark} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`bookmark-button-${messageId}`} />
              {onReportIssue ? (
                <DesktopMessageAction action="report" label="Report an issue with this message" tooltip="Report an issue" onPress={onReportIssue} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`report-button-${messageId}`} />
              ) : null}
              <DesktopMessageAction action="forward" label="Forward message" tooltip="Forward" onPress={onForward} onFocus={() => setDesktopActionsVisible(true)} onBlur={() => setDesktopActionsVisible(false)} testID={`forward-button-${messageId}`} />
            </>
          ) : null}
        </ButtonRowFrame>
        {!replyOnly && reactionPickerVisible ? (
          <DesktopWorkspacePortal>
            <ButtonRowFrame
              ref={pickerRef}
              position={'fixed' as 'absolute'}
              zIndex={4}
              top={pickerPosition?.top}
              left={pickerPosition?.left}
              opacity={pickerPosition ? 1 : 0}
              flexDirection="row"
              padding="1"
              borderWidth={1}
              borderColor="strongStroke"
              borderRadius="sm"
              backgroundColor="canvas"
              testID={`reaction-picker-${messageId}`}
            >
            {MESSAGE_REACTION_EMOJIS.map((emoji) => (
              <YStack
                accessibilityLabel={`React with ${emoji}`}
                accessibilityRole="button"
                key={emoji}
                onPress={() => {
                  onReact(emoji);
                  setReactionPickerVisible(false);
                }}
                width={36}
                height={34}
                alignItems="center"
                justifyContent="center"
                cursor="pointer"
                testID={`reaction-choice-${messageId}-${emoji}`}
              >
                <EmojiGlyph>{emoji}</EmojiGlyph>
              </YStack>
            ))}
            </ButtonRowFrame>
          </DesktopWorkspacePortal>
        ) : null}
      </XStack>
    );
  }
  // Swipeable's container clips (`overflow: 'hidden'`) at the row's content
  // edge, where the byline tile sits — and a live agent's gold ring paints
  // `ALIVE_RING_PAD` (one step) outside that tile. The clip box is outset by
  // the ring gutter and the children padded back by the same amount, so the
  // copy column never moves and the whole tile, ring included, stays visible.
  const swipeRow = () => (
    <RingOutset>
    <TranscriptSwipeable
      ref={swipeableRef}
      dragOffsetFromRightEdge={18}
      friction={1.35}
      actionsVisible={swipeShown}
      onSwipeableWillOpen={commitSwipe}
      onSwipeableClose={hideSwipe}
      onSwipeableOpenStartDrag={showSwipe}
      renderLeftActions={onSwipeThread ? () => (
        <SwipeAction side="left" icon={CornerDownRight} label="New thread" accessibilityLabel="Open a new thread from this message"
          shown={swipeShown} testID={`thread-swipe-action-${messageId}`} />
      ) : undefined}
      renderRightActions={onReply ? () => (
        <SwipeAction side="right" icon={CornerUpLeft} label="Reply" accessibilityLabel="Reply to message"
          shown={swipeShown} testID={`reply-swipe-action-${messageId}`} />
      ) : undefined}
      enabled={Boolean(onReply || onSwipeThread)}
      testID={`swipe-reply-${messageId}`}
    >
      <YStack paddingHorizontal="1">{message}</YStack>
    </TranscriptSwipeable>
    </RingOutset>
  );
  return swipeRow();
}


export interface OrdinaryLedgerMessageProps {
  message: ChatDisplayMessage;
  agent?: AgentPresentation;
  participantsHydrated: boolean;
  personName?: string;
  /** Current person portrait from the roster. Wins over a cached author snapshot. */
  personAvatar?: string;
  personFace?: string;
  viewerPubkey: string;
  /**
   * The speaker is WORKING right now — its own fresh working receipt
   * (`selectWorkingAgents`). Lights the byline's gold ring. Never the
   * delivery availability: an available daemon may not be working yet (C77).
   */
  speakerWorking: boolean;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  firstBylineOfDay?: boolean;
  referencedTarget?: MessageReplyDisplayTarget;
  participantHandles: readonly { pubkey: string; handle: string }[];
  channelIndex: ChannelReferenceIndex;
  deliveryFailed: boolean;
  sendState?: MessageSendState;
  sendFailureIds?: readonly string[];
  untaggedHint?: boolean;
  onChannelReference(target: ChannelReferenceTarget): void;
  codeRoomId?: string;
  onOpenCode?(messageId: string): void;
  onOpenSource?(roomId: string, messageId: string): void;
  onMention?(participantId: string): void;
  onOpenProfile?(participantId: string, kind?: 'human' | 'agent'): void;
  /** A tap on the row — the composer's "outside" — puts the keyboard away. */
  onTapOutsideComposer?(): void;
  onReply(message: ChatDisplayMessage): void;
  onCopy(text: string): void;
  /** Mobile long press on the row — opens the message actions sheet. */
  onMessageActions?(message: ChatDisplayMessage): void;
  onReact?(message: ChatDisplayMessage, emoji: MessageReactionEmoji): void;
  onForward?(message: ChatDisplayMessage): void;
  onBookmark?(message: ChatDisplayMessage): void;
  /** Report issue: prompt for a note and file the message with the feedback loop. */
  onReportIssue?(message: ChatDisplayMessage): void;
  /** Mobile swipe right — forward the message into a new human-owned corner. */
  onForwardToNewCorner?(message: ChatDisplayMessage): void;
  onCornerProposalDecision?(message: ChatDisplayMessage, decision: 'open' | 'cancel'): void;
  cornerProposalAction?: 'open' | 'cancel' | null;
  /** The human reply that answered this corner proposal, once one exists. */
  cornerProposalAnswer?: { decision: 'open' | 'cancel' | null; handle: string } | null;
  onRetry?(eventIds: readonly string[]): void;
  onDismiss(eventId: string): void;
  /** Read-only @system DMs are a full-width announcement feed, not a chat. */
  announcementFeed?: boolean;
  desktopLayout?: boolean;
}




/**
 * The connector receipt card: the structured card a connector DM carries
 * (connection, operation, helper, grant, counts — never a value). The
 * prose above stays a normal ledger entry; the card is the receipt.
 */
export const ConnectorReceiptCard = React.memo(function ConnectorReceiptCard({
  receipt,
  connectorName = 'Trusty Squire',
  identity,
}: {
  receipt: ConnectorReceipt;
  connectorName?: string;
  identity?: ChatDisplayMessage['authorIdentity'];
}) {
  return (
    <YStack marginTop="1" marginHorizontal="2" borderWidth={1} borderColor="strongStroke" borderRadius="sm" padding="2" gap="1" testID="connector-receipt-card">
      <XStack alignItems="center" gap="2">
        {identity?.avatar ? (
          <IdentityMark
            kind="human"
            seed={identity.pubkey}
            name={identity.name}
            avatarUrl={identity.avatar}
            size={26}
            testID="connector-receipt-logo"
          />
        ) : null}
        <T v="metaStrong" color="secondary" textTransform="uppercase">{identity?.name ?? connectorName}</T>
      </XStack>
      <T v="code" color="secondary">
        {receipt.connection} · {receipt.operation}
        {receipt.helper ? ` · on ${receipt.helper}` : ''}
      </T>
      <T v="code" color="secondary">
        {[
          receipt.grant ? `grant ${receipt.grant}` : undefined,
          receipt.calls !== undefined
            ? `${receipt.calls} ${receipt.calls === 1 ? 'call' : 'calls'}`
            : undefined,
          receipt.bytes,
        ]
          .filter(Boolean)
          .join(' · ')}
      </T>
      {/* One flat summary string; test assertions read it as a plain prop. */}
      <T v="code" color="secondary" testID="connector-receipt-summary">
        {[
          receipt.connection,
          receipt.operation,
          receipt.helper,
          receipt.grant ? `grant ${receipt.grant}` : undefined,
          receipt.calls !== undefined
            ? `${receipt.calls} ${receipt.calls === 1 ? 'call' : 'calls'}`
            : undefined,
          receipt.bytes,
        ]
          .filter(Boolean)
          .join(' · ')}
      </T>
    </YStack>
  );
});


/** The Room publishes its transcript after paint; subscribe so a browser reference
 * becomes actionable as soon as that authoritative snapshot is available. */
export function ViewerContextReference({ context, attachment, roomId, timestamp, isDesktop, testID }: {
  context: string; attachment?: AttachmentReference; roomId?: string; timestamp: number;
  isDesktop: boolean; testID: string;
}) {
  const conversation = useSyncExternalStore(subscribeViewerConversation,
    () => currentViewerConversation(roomId), () => currentViewerConversation(roomId));
  const browserTitle = context.startsWith('Viewing browser: ')
    ? context.slice('Viewing browser: '.length) : undefined;
  const browserSession = browserTitle ? [...(conversation?.messages ?? [])].reverse()
    .find((entry) => entry.createdAt <= timestamp && entry.computerSession?.title === browserTitle)
    ?.computerSession : undefined;
  return (
    <TranscriptReference viewer testID={testID}
    accessibilityLabel={browserTitle ? 'Open shared browser' : 'Open viewed artifact'}
    onPress={browserSession ? () => void openComputerSessionViewer(browserSession, isDesktop, roomId)
      : !browserTitle && attachment && !attachment.expired
        ? () => openArtifactViewer(attachment, isDesktop, roomId) : undefined}
  >{viewerContextLabel(context)}</TranscriptReference>
  );
}
