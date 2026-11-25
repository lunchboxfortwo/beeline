import React, { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { THREAD_LINK_MARK, type ChatLinkToken, type ChatLinkView } from '@beeline/api-contract/phone';
import { ProseRun, type ProseMark } from '@/ui/grammar';
import type { ChatLinkStore } from '@/buzz/chat-link-store';

export type OpenableChatLink = Exclude<ChatLinkView, { kind: 'private' }>;

export type ChatLinkAnchor =
  | { readonly kind: 'press' }
  | { readonly kind: 'hover'; readonly x: number; readonly y: number };

/** What a chat gives its links: where they were written, and how to open and preview them. */
export type ChatLinkSurface = {
  /** The Room or thread the links were written in. */
  readonly roomId: string;
  readonly store: ChatLinkStore;
  /** Web: hovering a link previews it. */
  readonly hover: boolean;
  open(link: OpenableChatLink): void;
  preview(link: OpenableChatLink, anchor: ChatLinkAnchor): void;
  /** Web: the pointer left the link; the card closes unless the pointer reaches it. */
  leave(): void;
};

/** Provided by `ChatLinkProvider`; without it every token stays plain text. */
export const ChatLinkContext = createContext<ChatLinkSurface | null>(null);

const PRIVATE_LABEL = { thread: '↳ private thread', message: '¶ private message' } as const;

type HoverEvent = { currentTarget?: { getBoundingClientRect?(): { left: number; bottom: number } } };

function useChatLinkEntry(surface: ChatLinkSurface | null, text: string, key: string) {
  const subscribe = useCallback(
    (listener: () => void) => surface?.store.subscribe(listener) ?? (() => undefined),
    [surface],
  );
  const entry = useSyncExternalStore(subscribe, () => surface?.store.read(surface.roomId, key));
  useEffect(() => {
    if (surface && entry === undefined) surface.store.request(surface.roomId, { text, key });
  }, [entry, surface, text, key]);
  return entry;
}

/** A Markdown link keeps its authored label and its own press handler. */
export function MessageLinkLabel({ id, label }: { id: string; label: string }) {
  const entry = useChatLinkEntry(useContext(ChatLinkContext), id, id);
  return <>{entry?.kind === 'thread' ? THREAD_LINK_MARK + label.replace(/^↳+/, '') : label}</>;
}

/**
 * One `↳thread` or `¶author-N` token inside prose, drawn like an @mention.
 * Until the server answers, and when it answers nothing, the token is the
 * words as written.
 */
export function ChatLinkRun({
  token,
  body,
  marks,
  level,
}: {
  token: ChatLinkToken;
  body: StyleProp<TextStyle>;
  /** The span's own marks (strong, emphasis, the block's tone). */
  marks: readonly ProseMark[];
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}) {
  const surface = useContext(ChatLinkContext);
  const entry = useChatLinkEntry(surface, token.text, token.key);

  if (!surface || !entry) {
    return marks.length ? <ProseRun body={body} marks={marks} level={level}>{token.text}</ProseRun> : <>{token.text}</>;
  }
  if (entry.kind === 'private') {
    return (
      <ProseRun body={body} marks={[...marks, 'quiet']} level={level} testID="chat-link-private">
        {PRIVATE_LABEL[token.kind]}
      </ProseRun>
    );
  }
  const link = entry;
  const hover = surface.hover
    ? {
        onMouseEnter: (event: HoverEvent) => {
          const rect = event.currentTarget?.getBoundingClientRect?.();
          surface.preview(link, { kind: 'hover', x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
        },
        onMouseLeave: surface.leave,
      }
    : {};
  return (
    <ProseRun
      accessibilityRole="link"
      accessibilityHint="Long press for a preview"
      body={body}
      marks={[...marks, 'brass']}
      level={level}
      onPress={() => surface.open(link)}
      onLongPress={() => surface.preview(link, { kind: 'press' })}
      testID={`chat-link-${link.kind}`}
      {...(hover as object)}
    >
      {token.text}
      {link.chatName ? <ProseRun marks={['quiet']}>{` · #${link.chatName}`}</ProseRun> : null}
    </ProseRun>
  );
}
