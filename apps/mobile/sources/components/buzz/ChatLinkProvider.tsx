import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { YStack } from 'tamagui';
import type { ChatLinkView } from '@beeline/api-contract/phone';
import { T } from '@/ui/grammar';
import { ledgerStamp } from '@/buzz/relative-time';
import type { ChatLinkStore } from '@/buzz/chat-link-store';
import { ChatLinkContext, type ChatLinkAnchor, type ChatLinkSurface, type OpenableChatLink } from './ChatLinks';
import { Button } from './Button';
import { HullFloatingSurface, HullModal } from './HullDialog';

const HOVER_CLOSE_MS = 250;

/** The place line of a preview: author, where it was written, and when. */
export function chatLinkPreviewLine(link: OpenableChatLink): string {
  const preview = link.preview;
  const place = link.kind === 'thread'
    ? `↳${link.name}`
    : link.threadName ? `↳${link.threadName}` : undefined;
  return [preview?.author, place, link.chatName ? `#${link.chatName}` : undefined,
    preview ? ledgerStamp(preview.createdAt) : undefined]
    .filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * Resolves `↳thread` and `¶author-N` tokens for one chat and opens them. Long
 * press (and hover on web) shows a one-line preview with Open.
 */
export function ChatLinkProvider({
  roomId,
  store,
  onOpenThread,
  onOpenMessage,
  children,
}: {
  roomId: string;
  store: ChatLinkStore;
  onOpenThread(link: Extract<ChatLinkView, { kind: 'thread' }>): void;
  onOpenMessage(link: Extract<ChatLinkView, { kind: 'message' }>): void;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState<{ link: OpenableChatLink; anchor: ChatLinkAnchor } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  useEffect(() => cancelClose, [cancelClose]);
  const open = useCallback((link: OpenableChatLink) => {
    cancelClose();
    setShown(null);
    if (link.kind === 'thread') onOpenThread(link);
    else onOpenMessage(link);
  }, [cancelClose, onOpenMessage, onOpenThread]);
  const leave = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setShown(null), HOVER_CLOSE_MS);
  }, [cancelClose]);
  const surface = useMemo<ChatLinkSurface>(() => ({
    roomId,
    store,
    hover: Platform.OS === 'web',
    open,
    preview(link, anchor) {
      cancelClose();
      setShown({ link, anchor });
    },
    leave,
  }), [cancelClose, leave, open, roomId, store]);

  const card = shown ? <ChatLinkPreviewCard link={shown.link} onOpen={() => open(shown.link)} /> : null;
  return (
    <ChatLinkContext.Provider value={surface}>
      {children}
      {shown?.anchor.kind === 'hover' ? (
        <YStack
          // Web only: fixed to the viewport just under the hovered link.
          position={'fixed' as 'absolute'}
          left={shown.anchor.x}
          top={shown.anchor.y}
          zIndex={20}
          maxWidth={360}
          {...({ onMouseEnter: cancelClose, onMouseLeave: leave } as object)}
        >
          {card}
        </YStack>
      ) : shown ? (
        <HullModal
          accessibilityLabel="Close link preview"
          onRequestClose={() => setShown(null)}
          placement="center"
          testID="chat-link-preview-modal"
          visible
        >
          {card}
        </HullModal>
      ) : null}
    </ChatLinkContext.Provider>
  );
}

/** Author, place and time on one line, the first line of the target, and Open. */
export function ChatLinkPreviewCard({ link, onOpen }: { link: OpenableChatLink; onOpen(): void }) {
  return (
    <HullFloatingSurface padding="4" gap="2" testID="chat-link-preview">
      <T v="meta" color="secondary">{chatLinkPreviewLine(link)}</T>
      {link.preview?.firstLine ? <T v="body">{link.preview.firstLine}</T> : null}
      <YStack alignItems="flex-start">
        <Button
          size="inline"
          label="Open"
          accessibilityLabel={link.kind === 'thread' ? `Open thread ${link.name}` : 'Open message'}
          onPress={onOpen}
          testID="chat-link-preview-open"
        />
      </YStack>
    </HullFloatingSurface>
  );
}
