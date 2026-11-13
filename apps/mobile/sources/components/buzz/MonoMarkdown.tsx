import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';
import { XStack, YStack } from 'tamagui';
import { Indent, ProseRun, T, type ProseMark } from '@/ui/grammar';
import { parseMarkdown, type MarkdownSpan } from '@/components/markdown/parseMarkdown';
import { CodeBlock } from '@/components/buzz/CodeBlock';
import {
  findChannelReferences,
  type ChannelReferenceIndex,
  type ChannelReferenceTarget,
} from '@/buzz/channel-reference';
import { messageLinkId, openMessageLink } from '@/buzz/message-link';
import { findChatLinkTokens, type ChatLinkToken } from '@beeline/api-contract/phone';
import { ChatLinkRun } from '@/components/buzz/ChatLinks';
import { openExternalUrl } from '@/utils/open-external-url';

/** The viewer's own normalized handle; a mention of it is highlighted. */
const ViewerMention = createContext<string | undefined>(undefined);

/**
 * A span split out of plain prose by `glossMentions` / `glossChannelReferences`
 * — the same MarkdownSpan plus flags for the two tagged-token families.
 * Kept local to this file: the parser above knows nothing about mentions or
 * channel references, and it must stay that way.
 */
type MentionSpan = MarkdownSpan & {
  mention?: boolean;
  channelRef?: ChannelReferenceTarget;
  /** A `↳thread` or `¶author-N` token; the server decides what it opens. */
  chatLink?: ChatLinkToken;
  /** The just-arrived region of a streaming draft (`tail`, C98). */
  tail?: boolean;
};

/**
 * A tagged identity in prose: `@` followed by a handle token (letters,
 * digits, `_`, `-` — the same character class the composer's mention picker
 * writes). Speakeasy's chat renders a tagged handle in accent brass; this is
 * Beeline's mapping of that effect onto the theme's own brass token.
 *
 * Deliberately narrow:
 *  - Plain prose only. Never inside code spans or links — a fenced block or a
 *    URL is machine text, not an address.
 *  - The character before `@` must be absent or non-handle text (whitespace,
 *    opening punctuation), so an email address (`user@example.com`) never
 *    glosses its domain.
 */
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function glossMentions(
  spans: MarkdownSpan[],
  liveMentionHandles: ReadonlySet<string> = new Set(),
): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const span of spans) {
    if (span.url || span.styles.includes('code')) {
      out.push(span);
      continue;
    }
    const text = span.text;
    let last = 0;
    for (const match of text.matchAll(MENTION_PATTERN)) {
      const at = match.index ?? 0;
      const before = at > 0 ? text[at - 1]! : '';
      if (/[A-Za-z0-9_.-]/.test(before)) continue;
      const handle = (match[1] ?? '').normalize('NFKC').toLocaleLowerCase();
      if (!liveMentionHandles.has(handle)) continue;
      if (at > last) out.push({ ...span, text: text.slice(last, at) });
      out.push({ ...span, text: match[0], mention: true });
      last = at + match[0].length;
    }
    if (last === 0) out.push(span);
    else if (last < text.length) out.push({ ...span, text: text.slice(last) });
  }
  return out;
}

/**
 * Explicit `#room` / `#room/corner` references resolved against the CURRENT
 * workspace's known channels (`@/buzz/channel-reference`). Same discipline as
 * mentions, one family over: only plain prose spans are glossed — never code,
 * URLs, or an existing mention span — and only tokens that resolve EXACTLY
 * become links; everything else stays ordinary text. The index comes from the
 * caller and must be referentially stable across unrelated renders (memoize
 * it) so this component's React.memo bailout keeps working.
 */
export function glossChannelReferences(
  spans: MentionSpan[],
  index: ChannelReferenceIndex | undefined,
): MentionSpan[] {
  if (!index) return spans;
  const out: MentionSpan[] = [];
  for (const span of spans) {
    // A mention span is already a tagged token; url/code are machine text.
    if (span.url || span.styles.includes('code') || span.mention) {
      out.push(span);
      continue;
    }
    const matches = findChannelReferences(span.text, index);
    if (matches.length === 0) {
      out.push(span);
      continue;
    }
    let last = 0;
    for (const match of matches) {
      if (match.start > last) out.push({ ...span, text: span.text.slice(last, match.start) });
      out.push({ ...span, text: match.text, channelRef: match.target });
      last = match.end;
    }
    if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }
  return out;
}

/**
 * `↳thread` and `¶author-N` tokens in plain prose. Same discipline as the
 * other two families: never inside code, a URL, a mention or a channel
 * reference. Whether a token links is the server's answer (`ChatLinkRun`).
 */
export function glossChatLinks(spans: MentionSpan[]): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const span of spans) {
    if (span.url || span.styles.includes('code') || span.mention || span.channelRef) {
      out.push(span);
      continue;
    }
    const tokens = findChatLinkTokens(span.text);
    if (!tokens.length) {
      out.push(span);
      continue;
    }
    let last = 0;
    for (const token of tokens) {
      if (token.start > last) out.push({ ...span, text: span.text.slice(last, token.start) });
      out.push({ ...span, text: token.text, chatLink: token });
      last = token.end;
    }
    if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }
  return out;
}

type MonoMarkdownProps = {
  markdown: string;
  /**
   * The caller's own body style. Required in practice: the ledger owns every
   * transcript text tone (`components/buzz/Ledger.tsx`), so this component no
   * longer carries canned tones of its own.
   */
  textStyle: TextStyle;
  /** Give full-page attachments a reading rhythm without changing chat rows. */
  document?: boolean;
  /**
   * A node set as the very first inline child of the first text block — the
   * ledger's speaker handle, so an entry reads as one log line (handle, then
   * the words, wrapping beneath) instead of a name on its own row.
   *
   * It is nested *inside* the paragraph's `Text` rather than placed beside it,
   * which is both what makes it wrap as part of the sentence and what keeps it
   * clear of the Android bug where a `flex: 1` `Text` holding only other `Text`
   * inside a row `View` lays out at zero height.
   *
   * When the first block cannot host an inline child (a fence, a rule, a table
   * opening the message), it falls back to its own line above the content.
   */
  leadingInline?: React.ReactNode;
  /** Handles backed by this event's real p-tags and current Room members. */
  mentionHandles?: readonly string[];
  /** The viewer's own handle; a resolved mention of it is highlighted. */
  viewerHandle?: string;
  /** Invoked for a resolved member mention. The handle is normalized. */
  onMention?: (handle: string) => void;
  /** Known rooms/corners of THIS workspace; omitted → no reference is linked. */
  channelIndex?: ChannelReferenceIndex;
  /** Invoked when a recognized `#room`/`#room/corner` reference is pressed. */
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  /** Stable Room/message coordinates used to resolve code after navigation. */
  codeSource?: { roomId: string; messageId: string };
  /** Arms the transcript return anchor before the full-page reader opens. */
  onOpenCode?: (messageId: string) => void;
  /**
   * The trailing characters that have only just arrived on a message (C98).
   * They take `style` on top of the body tone so a fade lands on the new text
   * alone; everything before them is left exactly as it was rendered a frame
   * ago.
   *
   * The live draft lane is NOT a caller: it prints its words through one plain
   * `Text` (`components/buzz/StreamingProse.tsx`), because rebuilding this
   * block tree for every cumulative snapshot is the #1588 regression. This
   * stays for a durable surface that wants to mark its own arriving tail.
   *
   * Scoped to the LAST block, which is where a stream is always writing. A
   * fence or a table closing the message simply does not fade — better than
   * animating a region the reader cannot see arrive.
   */
  tail?: { readonly length: number; readonly style: TextStyle };
  testID?: string;
};

/**
 * Flag the final `length` characters of a block's spans, splitting the span
 * they start inside. Pure, and exported for the honesty test: the marked
 * region is always a suffix, never longer than the text it is taken from.
 */
export function markTailSpans(spans: MentionSpan[], length: number): MentionSpan[] {
  if (length <= 0) return spans;
  let remaining = length;
  const out: MentionSpan[] = [];
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    if (remaining <= 0) {
      out.unshift(span);
      continue;
    }
    if (span.text.length <= remaining) {
      remaining -= span.text.length;
      out.unshift({ ...span, tail: true });
      continue;
    }
    const cut = span.text.length - remaining;
    // A link token split by the arriving tail is not whole; draw its words.
    const { chatLink: _split, ...whole } = span;
    out.unshift({ ...whole, text: span.text.slice(cut), tail: true });
    out.unshift({ ...whole, text: span.text.slice(0, cut) });
    remaining = 0;
  }
  return out;
}

/**
 * Column flex weights for a pipe table: each column's longest cell, clamped
 * so one huge column cannot squeeze the rest into slivers. Every row hands
 * this same weight list to the same flex layout — that is what keeps the
 * column boundaries aligned across the whole table while each cell wraps
 * inside its own column.
 */
export const TABLE_MIN_COLUMN_WEIGHT = 3;
export const TABLE_MAX_COLUMN_WEIGHT = 48;

export function tableColumnWeights(rows: string[][]): number[] {
  const columnCount = rows.reduce((count, row) => Math.max(count, row.length), 1);
  return Array.from({ length: columnCount }, (_, column) => {
    let longest = 0;
    for (const row of rows) longest = Math.max(longest, (row[column] ?? '').length);
    return Math.min(TABLE_MAX_COLUMN_WEIGHT, Math.max(TABLE_MIN_COLUMN_WEIGHT, longest));
  });
}

/** Block kinds whose renderer starts with a `Text` that can host the handle. */
const INLINE_HOSTS = new Set(['text', 'header', 'list', 'numbered-list']);

/**
 * A span's marks over its block's. Emphasis is a luminance step, never a
 * heavier cut: `**strong**` climbs to ink in the semibold face (a no-op on
 * agent output, already the brightest tier). Space Grotesk ships no italic, so
 * emphasis is spoken by weight in the prose family.
 */
function spanMarks(span: MentionSpan, viewerHandle?: string): ProseMark[] {
  const marks: ProseMark[] = [];
  if (span.styles.includes('bold') || span.styles.includes('semibold')) marks.push('strong');
  if (span.styles.includes('italic')) marks.push('emphasis');
  if (span.styles.includes('code')) marks.push('code');
  if (span.url) marks.push('link');
  // A tagged identity, and a resolved channel reference, pop in the theme's
  // brass: the one chromatic spend in prose, never a new accent or chip.
  if (span.mention || span.channelRef) marks.push('brass');
  // A mention of the viewer: semibold brass on the highlight.
  if (span.mention && viewerHandle !== undefined &&
    span.text.slice(1).normalize('NFKC').toLocaleLowerCase() === viewerHandle) marks.push('viewer');
  return marks;
}

function InlineMarkdown({
  spans,
  base,
  baseMarks = [],
  level,
  onLink,
  liveMentionHandles,
  onMention,
  channelIndex,
  onChannelReference,
  tail,
}: {
  spans: MarkdownSpan[];
  base: StyleProp<TextStyle>;
  /** The block's own marks (a heading's ink, a quote's secondary). */
  baseMarks?: ProseMark[];
  /** A document heading's level. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  onLink: (url: string) => void;
  liveMentionHandles: ReadonlySet<string>;
  onMention?: (handle: string) => void;
  channelIndex?: ChannelReferenceIndex;
  onChannelReference?: (target: ChannelReferenceTarget, text: string) => void;
  tail?: { readonly length: number; readonly style: TextStyle };
}) {
  // One funnel: every prose block (text, header, list items) renders its spans
  // here, so a mention or a channel reference glosses identically wherever it
  // is spoken.
  const viewerHandle = useContext(ViewerMention);
  const glossed = markTailSpans(
    glossChatLinks(glossChannelReferences(glossMentions(spans, liveMentionHandles), channelIndex)),
    tail?.length ?? 0,
  );
  return (
    <>
      {glossed.map((span, index) => {
        // Unmarked words inherit their paragraph's type. A second styled Text
        // adds a Fabric node and repeats token resolution for the same body.
        if (span.chatLink && !span.tail) {
          return (
            <ChatLinkRun
              key={`${span.text}-${index}`}
              token={span.chatLink}
              body={base}
              marks={[...baseMarks, ...spanMarks(span, viewerHandle)]}
              level={level}
            />
          );
        }
        if (!span.styles.length && !span.url && !span.mention && !span.channelRef && !span.tail) return span.text;
        return (
          <ProseRun
            accessibilityRole={
              (span.mention && onMention) || (span.channelRef && onChannelReference) || span.url
                ? 'link'
                : undefined
            }
            key={`${span.text}-${index}`}
            onPress={
              span.mention && onMention
                ? () => onMention(span.text.slice(1).normalize('NFKC').toLocaleLowerCase())
                : span.channelRef && onChannelReference
                  ? () => onChannelReference(span.channelRef!, span.text)
                  : span.url
                    ? () => onLink(span.url!)
                    : undefined
            }
            body={base}
            marks={[...baseMarks, ...spanMarks(span, viewerHandle)]}
            level={level}
            // Last, so the arriving tail's tone wins over the settled body's.
            fade={span.tail ? tail?.style : undefined}
          >
            {span.text}
          </ProseRun>
        );
      })}
    </>
  );
}

/**
 * Compact markdown for the Mono Hull transcript, with real hierarchy and no raw syntax.
 *
 * Memoized: this renders once per transcript row inside FlatList's renderItem,
 * which is recreated on every presence tick (room-enter and live updates) —
 * without this, every row's markdown-to-JSX tree gets rebuilt on updates
 * unrelated to that row's own text.
 *
 * The memo needs more than a shallow compare: the transcript's renderItem
 * derives `mentionHandles` with `.filter().map()` INSIDE the row builder, so
 * every presence-tick re-invocation hands down a NEW array with EQUAL
 * contents. A default shallow compare fails on that identity churn and
 * defeats the bailout for every visible row on every tick — the confirmed
 * enter-Room freeze family. The comparator below value-compares only that
 * one array prop; everything else stays a strict identity check so any real
 * change (text, style, callback, index) still re-renders.
 */
function mentionHandlesEqual(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

export function monoMarkdownPropsAreEqual(
  previous: MonoMarkdownProps,
  next: MonoMarkdownProps,
): boolean {
  return (
    previous.markdown === next.markdown &&
    previous.textStyle === next.textStyle &&
    previous.document === next.document &&
    previous.leadingInline === next.leadingInline &&
    previous.channelIndex === next.channelIndex &&
    previous.onChannelReference === next.onChannelReference &&
    previous.codeSource?.roomId === next.codeSource?.roomId &&
    previous.codeSource?.messageId === next.codeSource?.messageId &&
    previous.onOpenCode === next.onOpenCode &&
    previous.onMention === next.onMention &&
    previous.viewerHandle === next.viewerHandle &&
    previous.testID === next.testID &&
    previous.tail?.length === next.tail?.length &&
    previous.tail?.style === next.tail?.style &&
    mentionHandlesEqual(previous.mentionHandles, next.mentionHandles)
  );
}

function markdownTableCellText(cell: MarkdownSpan[]): string {
  return cell.map((span) => span.text).join('');
}

/**
 * A pipe table is machine output, so it keeps the fenced block's vocabulary —
 * the 2px left rule, the mono body — but renders as an aligned wrapping grid
 * instead of the flattened `  |  ` join whose rows ran off the tile's right
 * edge. One flex weight per column (its longest cell, clamped), shared by
 * every row: column boundaries align across the whole table and a long cell
 * wraps inside its column. No horizontal scroll — a table fits the tile or
 * its cells wrap.
 */
function MarkdownTable({ headers, rows, onLink }: { headers: MarkdownSpan[][]; rows: MarkdownSpan[][][]; onLink: (url: string) => void }) {
  const grid = [headers, ...rows];
  const weights = useMemo(() => tableColumnWeights(grid.map((row) => row.map(markdownTableCellText))), [headers, rows]);
  return (
    <YStack width="100%" minWidth={0}>
      {grid.map((row, rowIndex) => (
        // A hairline between rows in the machine vocabulary; the header lifts to ink.
        <XStack
          key={rowIndex}
          alignItems="flex-start"
          columnGap="2"
          paddingVertical="1"
          borderBottomWidth={rowIndex === grid.length - 1 ? 0 : 1}
          borderBottomColor="stroke"
        >
          {Array.from({ length: weights.length }, (_, column) => (
            <YStack key={column} minWidth={0} flex={weights[column] ?? 1}>
              <T v="code" userSelect="text" color={rowIndex === 0 ? 'ink' : 'secondary'}>
                {(row[column] ?? []).map((span, spanIndex) => (
                  <ProseRun
                    key={spanIndex}
                    accessibilityRole={span.url ? 'link' : undefined}
                    onPress={span.url ? () => onLink(span.url!) : undefined}
                    marks={[span.styles.includes('bold') && 'strong', span.styles.includes('italic') && 'emphasis', Boolean(span.url) && 'link']}
                  >{span.text}</ProseRun>
                ))}
              </T>
            </YStack>
          ))}
        </XStack>
      ))}
    </YStack>
  );
}

export const MonoMarkdown = React.memo(function MonoMarkdown({
  markdown,
  textStyle,
  document = false,
  leadingInline,
  mentionHandles,
  viewerHandle,
  onMention,
  channelIndex,
  onChannelReference,
  codeSource,
  onOpenCode,
  tail,
  testID,
}: MonoMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown, document), [markdown, document]);
  // Android starts native text selection under a long-pressed link as well as
  // the link's preview. The row's long press already owns selection there
  // (the message menu's Select), so prose holding a link is not selectable.
  // Tamagui reads an absent userSelect as selectable, so say 'none'.
  const proseSelect = Platform.OS === 'android' && findChatLinkTokens(markdown).length ? 'none' : 'text';
  const liveMentionHandles = useMemo(
    () =>
      new Set((mentionHandles ?? []).map((handle) => handle.normalize('NFKC').toLocaleLowerCase())),
    [mentionHandles],
  );
  const base = textStyle;
  const onLink = useCallback((url: string) => {
    if (messageLinkId(url)) {
      void openMessageLink(url).catch(async () => {
        const { Modal } = await import('@/modal/ModalManager');
        Modal.alert('Message not available', 'This message could not be opened. Check your access and try again.');
      });
      return;
    }
    if (/^https?:\/\//i.test(url)) void openExternalUrl(url).catch(() => undefined);
  }, []);
  const first = blocks[0];
  const inlineHosted =
    Boolean(leadingInline) &&
    Boolean(first) &&
    INLINE_HOSTS.has(first.type) &&
    !('items' in first && first.items.length === 0);

  const viewerMention = viewerHandle?.replace(/^@/, '').normalize('NFKC').toLocaleLowerCase();
  return (
    <ViewerMention.Provider value={viewerMention}>
    <YStack width="100%" minWidth={0} testID={testID}>
      {leadingInline && !inlineHosted ? (
        <ProseRun userSelect={proseSelect} marginBottom="2" body={base}>
          {leadingInline}
        </ProseRun>
      ) : null}
      {/* Blocks sit 8 apart; full-page attachments read at 16. */}
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        const lead = inlineHosted && index === 0 ? leadingInline : null;
        // The stream is always writing at the end of the message.
        const trail = last ? tail : undefined;

        if (block.type === 'text') {
          return (
            <ProseRun key={index} userSelect={proseSelect} marginBottom={last ? 0 : document ? '4' : '2'} body={base}>
              {lead}
              <InlineMarkdown
                spans={block.content}
                base={base}
                onLink={onLink}
                liveMentionHandles={liveMentionHandles}
                onMention={onMention}
                channelIndex={channelIndex}
                onChannelReference={onChannelReference}
                tail={trail}
              />
            </ProseRun>
          );
        }
        if (block.type === 'header') {
          // A heading gets air rather than mass, in ink; a document heading takes its level's type style.
          const level = document ? (Math.min(6, Math.max(1, block.level)) as 1 | 2 | 3 | 4 | 5 | 6) : undefined;
          return (
            <ProseRun
              key={index}
              userSelect={proseSelect}
              marginTop={document ? (index === 0 ? 0 : '4') : '1'}
              marginBottom={document || !last ? '2' : 0}
              body={base}
              marks={['strong']}
              level={level}
            >
              {lead}
              <InlineMarkdown
                spans={block.content}
                base={base}
                baseMarks={['strong']}
                level={level}
                onLink={onLink}
                liveMentionHandles={liveMentionHandles}
                onMention={onMention}
                channelIndex={channelIndex}
                onChannelReference={onChannelReference}
                tail={trail}
              />
            </ProseRun>
          );
        }
        if (block.type === 'quote') {
          return (
            <YStack key={index} borderLeftWidth={2} borderLeftColor="stroke" paddingLeft="4" paddingVertical={document ? '2' : 0} marginBottom={last ? 0 : document ? '4' : '2'}>
              <ProseRun userSelect={proseSelect} body={base} marks={['quiet']}>
                <InlineMarkdown spans={block.content} base={base} baseMarks={['quiet']} onLink={onLink} liveMentionHandles={liveMentionHandles} onMention={onMention} channelIndex={channelIndex} onChannelReference={onChannelReference} tail={trail} />
              </ProseRun>
            </YStack>
          );
        }
        if (block.type === 'list' || block.type === 'numbered-list') {
          return (
            <YStack key={index} width="100%" gap={document ? '2' : '1'} marginBottom={last ? 0 : document ? '4' : '2'}>
              {block.items.map((item, itemIndex) => (
                <Indent key={itemIndex} depth={item.depth}>
                  <ProseRun
                    userSelect={proseSelect}
                    width="100%"
                    body={base}
                  >
                    {itemIndex === 0 ? lead : null}
                    <ProseRun marks={['quiet']}>
                      {'number' in item ? `${item.number}. ` : '· '}
                    </ProseRun>
                    <InlineMarkdown
                      spans={item.spans}
                      base={base}
                      onLink={onLink}
                      liveMentionHandles={liveMentionHandles}
                      onMention={onMention}
                      channelIndex={channelIndex}
                      onChannelReference={onChannelReference}
                      tail={itemIndex === block.items.length - 1 ? trail : undefined}
                    />
                  </ProseRun>
                </Indent>
              ))}
            </YStack>
          );
        }
        if (block.type === 'code-block' || block.type === 'mermaid') {
          const code = block.content;
          const language = 'language' in block ? (block.language ?? null) : null;
          const blockIndex = blocks
            .slice(0, index)
            .filter(
              (candidate) => candidate.type === 'code-block' || candidate.type === 'mermaid',
            ).length;
          return (
            <YStack key={index} marginBottom={last ? 0 : document ? '4' : '2'}>
              <CodeBlock
                code={code}
                language={language}
                roomId={codeSource?.roomId}
                messageId={codeSource?.messageId}
                blockIndex={blockIndex}
                onOpen={onOpenCode}
              />
            </YStack>
          );
        }
        if (block.type === 'horizontal-rule') {
          return <YStack key={index} height={1} backgroundColor="stroke" marginTop="1" marginBottom={last ? 0 : document ? '4' : '2'} />;
        }
        if (block.type === 'table') {
          // Tables share the 2px left-rule vocabulary; fenced code owns its frame in CodeBlock.tsx.
          return (
            <YStack key={index} maxWidth="100%" paddingLeft="4" paddingVertical="1" borderLeftWidth={2} borderLeftColor="strongStroke" marginBottom={last ? 0 : document ? '4' : '2'}>
              <MarkdownTable headers={block.headers} rows={block.rows} onLink={onLink} />
            </YStack>
          );
        }
        if (block.type === 'options') {
          return (
            <ProseRun key={index} userSelect={proseSelect} marginBottom={last ? 0 : document ? '4' : '2'} body={base}>
              {block.items.map((item) => `· ${item}`).join('\n')}
            </ProseRun>
          );
        }
        if (block.type === 'image') {
          return (
            <ProseRun
              key={index}
              marginBottom={last ? 0 : document ? '4' : '2'}
              body={base}
              marks={['link']}
              onPress={() => onLink(block.url)}
            >
              {block.alt || block.url}
            </ProseRun>
          );
        }
        return null;
      })}
    </YStack>
    </ViewerMention.Provider>
  );
}, monoMarkdownPropsAreEqual);
