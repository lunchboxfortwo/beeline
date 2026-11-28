import type { ActivityResultBlock } from '@beeline/api-contract/phone';
import { ErrorBanner } from './ErrorBanner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { typeRoles } from '@beeline/design-tokens';
import type { ToolIdentityLookup } from '@/buzz/tool-identity-lookup';
import {
  buildToolSheetPresentation,
  formatBytesCompact,
  type ToolSheetBody,
} from '@/buzz/tool-output-format';
import { HULL_SHEET_INSET, HullActionSheetModal } from './HullActionSheet';
import { Button } from './Button';
import { CodeHighlighter } from './CodeHighlighter';
import { LedgerDisclosure } from './LedgerDisclosure';

/** The source line every machine body is written to. */
const OUTPUT_COLUMNS = 80;
/** IBM Plex Mono advances 600/1000 of its em, so a column is 0.6 of the size. */
const MACHINE_ADVANCE = 0.6;
const INITIAL_ARRAY_CARDS = 10;

export const TOOL_OUTPUT_SHEET_MAX_WIDTH = Math.round(
  OUTPUT_COLUMNS * MACHINE_ADVANCE * typeRoles.machine.fontSize + HULL_SHEET_INSET * 2,
);

export type ToolOutputSheetProps = {
  title: string;
  subtitle?: string;
  searchScope?: 'web' | 'code' | 'history' | 'memory' | 'tools';
  command?: string | null;
  input?: string | null;
  summary?: string | null;
  receipt?: string | null;
  detail: string | null | undefined;
  rawOutput?: string | null;
  blocks?: readonly ActivityResultBlock[];
  files?: readonly {
    path: string;
    status?: string;
    diff?: string;
    diffTruncated?: boolean;
    line?: number;
    endLine?: number;
  }[];
  plan?: {
    objective?: string;
    items: readonly { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
  };
  outcome?: 'running' | 'success' | 'failure';
  exitCode?: number;
  signal?: string;
  outputTruncated?: boolean;
  omittedCount?: number;
  sanitized?: boolean;
  terminalOnly?: boolean;
  requester?: string;
  lookup?: ToolIdentityLookup;
  error?: string | null;
  outputHidden?: boolean;
  /**
   * When set, render Two Inks and wrap. Omitted for ordinary tool output,
   * which renders result-first structured blocks or wrapped machine text.
   */
  language?: string | null;
  visible: boolean;
  onClose: () => void;
  testID?: string;
};

function formatToolInput(input: string | null | undefined): string | undefined {
  if (!input?.trim()) return undefined;
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}


/**
 * Universal 2-zone ACP tool output sheet:
 * - Full wrapping title + honest status/signal/bounded/sanitized badges
 * - Zone 1: ordered universal ACP result blocks (diff, structured JSON, strict matches,
 *   media receipt, resource card, checklist, sent message, caption, mono, or honest completion)
 * - Zone 2: collapsible invocation/raw data, NEVER duplicating plain mono text already shown
 *   in Zone 1, with honest Copy labeling (`Copy excerpt` / `Copy command` / `Copy JSON`).
 */
export function ToolOutputSheet({
  title,
  subtitle,
  searchScope,
  command,
  input,
  summary,
  receipt,
  detail,
  rawOutput,
  blocks,
  files,
  plan,
  outcome,
  exitCode,
  signal,
  outputTruncated,
  omittedCount,
  sanitized,
  terminalOnly,
  requester,
  lookup,
  outputHidden,
  error,
  language,
  visible,
  onClose,
  testID = 'tool-output-sheet',
}: ToolOutputSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [showAllCards, setShowAllCards] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const presentation = useMemo(
    () =>
      buildToolSheetPresentation({
        title,
        subtitle,
        searchScope,
        command,
        input,
        summary,
        receipt,
        detail,
        rawOutput,
        blocks,
        files,
        plan,
        outcome,
        exitCode,
        signal,
        outputTruncated,
        omittedCount,
        sanitized,
        terminalOnly,
        outputHidden,
        requester,
        lookup,
      }),
    [
      title,
      subtitle,
      searchScope,
      command,
      input,
      summary,
      receipt,
      detail,
      rawOutput,
      blocks,
      files,
      plan,
      outcome,
      exitCode,
      signal,
      outputTruncated,
      omittedCount,
      sanitized,
      terminalOnly,
      outputHidden,
      requester,
      lookup,
    ],
  );

  useEffect(() => {
    setRawExpanded(Boolean(presentation.autoExpandZone2));
    setShowAllCards(false);
    setCopied(false);
  }, [visible, title, detail, rawOutput, presentation.autoExpandZone2]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyPayload = presentation.rawText ?? detail ?? undefined;
  const copy = useCallback(async () => {
    if (!copyPayload || outputHidden) return;
    try {
      await (await import('expo-clipboard')).setStringAsync(copyPayload);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [copyPayload, outputHidden]);

  const isLoading = detail === 'Loading…';
  const canCopy = Boolean(presentation.canCopy && copyPayload && !outputHidden && !isLoading && !error);
  const highlight = language !== undefined;
  const shownCommand = !outputHidden && command?.trim() ? command.trim() : undefined;
  const formattedInput = !outputHidden ? formatToolInput(input) : undefined;
  const shownInput =
    formattedInput && (!shownCommand || formattedInput !== shownCommand) ? formattedInput : undefined;
  // Never duplicate raw mono output or command/arguments in Zone 2 Output.
  const rawZone2Output =
    rawOutput?.trim() ||
    detail?.trim() ||
    (presentation.rawText &&
    presentation.rawText !== shownCommand &&
    presentation.rawText !== shownInput
      ? presentation.rawText
      : undefined);
  const showRawOutputInZone2 = Boolean(!presentation.zone1ShowsMonoVerbatim && rawZone2Output);
  const hasZone2Content = Boolean(
    !outputHidden &&
      !isLoading &&
      !error &&
      (shownCommand || shownInput || showRawOutputInZone2),
  );

  return (
    <HullActionSheetModal
      contentMaxWidth={TOOL_OUTPUT_SHEET_MAX_WIDTH}
      onClose={onClose}
      subtitle={presentation.subtitle}
      testID={testID}
      title={presentation.title}
      wrapTitle
      visible={visible}
    >
      <ScrollView
        nestedScrollEnabled
        flexGrow={0}
        flexShrink={1}
        maxHeight={Math.max(0, Math.round(windowHeight * 0.82) - 130 - insets.bottom)}
        testID="tool-output-scroll"
      >
        <YStack paddingHorizontal="6" gap="3">
          {presentation.statusLine || presentation.badges.length > 0 ? (
            <XStack flexWrap="wrap" alignItems="center" justifyContent="flex-start" gap="2">
              {presentation.statusLine ? (
                <T
                  v={presentation.statusTone === 'danger' ? 'metaStrong' : 'code'}
                  color={presentation.statusTone === 'danger' ? 'ink' : 'secondary'}
                  testID="tool-output-status"
                >
                  {presentation.statusLine}
                </T>
              ) : null}
              {presentation.badges.map((badge, index) => (
                <YStack
                  key={`${badge.label}-${index}`}
                  paddingHorizontal="2"
                  paddingVertical="0.5"
                  borderRadius="sm"
                  borderWidth={1}
                  borderColor={badge.tone === 'danger' ? 'ink' : 'strongStroke'}
                  backgroundColor="raised"
                  testID={index === 0 ? 'tool-output-badge' : `tool-output-badge-${index}`}
                >
                  <T
                    v={badge.tone === 'danger' ? 'metaStrong' : 'code'}
                    color={badge.tone === 'danger' ? 'ink' : 'secondary'}
                  >
                    {badge.label}
                  </T>
                </YStack>
              ))}
            </XStack>
          ) : null}
          {error ? (
            <ErrorBanner inline title={error} />
          ) : highlight ? (
            <CodeHighlighter code={detail ?? ''} language={language} />
          ) : isLoading ? (
            <T v="meta" color="secondary" testID="tool-output-text">
              Loading…
            </T>
          ) : (
            <YStack gap="3">
              {presentation.blocks.map((block, blockIndex) => (
                <React.Fragment key={`${block.kind}-${blockIndex}`}>
                  {(() => {
                  if (block.kind === 'secret') {
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        testID="tool-output-secret"
                      >
                        <T v="meta" color="secondary" testID="tool-output-text">
                          {block.notice}
                        </T>
                      </YStack>
                    );
                  }

                  if (block.kind === 'caption') {
                    return (
                      <T v="meta" color="ink" userSelect="text" testID={`tool-output-caption-${blockIndex}`}>
                        {block.text}
                      </T>
                    );
                  }

                  if (block.kind === 'sent-message') {
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        gap="2"
                        testID="tool-output-sent-message"
                      >
                        {block.fromTo || block.tag ? (
                          <XStack
                            justifyContent="space-between"
                            alignItems="center"
                            paddingBottom="2"
                            borderBottomWidth={0.5}
                            borderBottomColor="stroke"
                          >
                            <T v="meta" color="secondary">
                              {block.fromTo ?? ''}
                            </T>
                            <T v="meta" color="secondary">
                              {block.tag ?? ''}
                            </T>
                          </XStack>
                        ) : null}
                        <T v="body" color="ink" userSelect="text" testID="tool-output-text">
                          {block.text}
                        </T>
                      </YStack>
                    );
                  }

                  if (block.kind === 'diff') {
                    return (
                      <YStack gap="3" testID="tool-output-diff">
                        {block.files.map((file, fileIndex) => (
                          <YStack
                            key={`${file.path}-${fileIndex}`}
                            backgroundColor="raised"
                            borderWidth={1}
                            borderColor="stroke"
                            borderRadius="sm"
                            overflow="hidden"
                          >
                            <XStack
                              alignItems="center"
                              justifyContent="space-between"
                              gap="2"
                              paddingHorizontal="3"
                              paddingVertical="2"
                              backgroundColor="highlight"
                              borderBottomWidth={0.5}
                              borderBottomColor="stroke"
                            >
                              <XStack alignItems="center" gap="2" flex={1} minWidth={0}>
                                {file.status ? (
                                  <T v="metaStrong" color="ink" flexShrink={0}>
                                    {file.status}
                                  </T>
                                ) : null}
                                <T v="code" color="secondary" flex={1} minWidth={0} numberOfLines={1}>
                                  {file.path}
                                </T>
                              </XStack>
                              {file.truncated ? (
                                <T v="code" color="secondary" flexShrink={0}>
                                  partial
                                </T>
                              ) : null}
                            </XStack>
                            <YStack paddingVertical="1">
                              {file.lines.map((line, lineIndex) => (
                                <YStack
                                  key={lineIndex}
                                  paddingHorizontal="3"
                                  paddingVertical="0.5"
                                  backgroundColor={line.kind === 'hunk' ? 'highlight' : 'transparent'}
                                  borderLeftWidth={line.kind === 'add' || line.kind === 'del' ? 2 : 0}
                                  borderLeftColor={
                                    line.kind === 'add'
                                      ? 'added'
                                      : line.kind === 'del'
                                        ? 'removed'
                                        : 'transparent'
                                  }
                                >
                                  <T
                                    v="code"
                                    color={
                                      line.kind === 'add'
                                        ? 'added'
                                        : line.kind === 'del'
                                          ? 'removed'
                                          : line.kind === 'hunk'
                                            ? 'secondary'
                                            : 'ink'
                                    }
                                    userSelect="text"
                                  >
                                    {line.text}
                                  </T>
                                </YStack>
                              ))}
                            </YStack>
                          </YStack>
                        ))}
                      </YStack>
                    );
                  }

                  if (block.kind === 'matches') {
                    return (
                      <YStack gap="2" testID="tool-output-matches">
                        {block.groups.map((group, groupIndex) => (
                          <YStack
                            key={`${group.path}-${groupIndex}`}
                            backgroundColor="raised"
                            borderWidth={1}
                            borderColor="stroke"
                            borderRadius="sm"
                            overflow="hidden"
                          >
                            <XStack
                              alignItems="center"
                              justifyContent="space-between"
                              gap="2"
                              paddingHorizontal="3"
                              paddingVertical="2"
                              backgroundColor="highlight"
                              borderBottomWidth={0.5}
                              borderBottomColor="stroke"
                            >
                              <T v="code" color="secondary" flex={1} minWidth={0} numberOfLines={1}>
                                {group.path}
                              </T>
                              {!block.truncated ? (
                                <T v="code" color="secondary" flexShrink={0}>
                                  {`${group.matches.length} ${group.matches.length === 1 ? 'match' : 'matches'}`}
                                </T>
                              ) : (
                                <T v="code" color="secondary" flexShrink={0}>
                                  excerpt
                                </T>
                              )}
                            </XStack>
                            {group.matches.map((match, matchIndex) => (
                              <XStack
                                key={`${match.line}-${matchIndex}`}
                                alignItems="flex-start"
                                gap="2"
                                paddingHorizontal="3"
                                paddingVertical="2"
                                borderTopWidth={matchIndex > 0 ? 0.5 : 0}
                                borderTopColor="stroke"
                              >
                                <T
                                  v="code"
                                  color="secondary"
                                  minWidth={28}
                                  textAlign="right"
                                  flexShrink={0}
                                  fontVariant={['tabular-nums']}
                                >
                                  {String(match.line)}
                                </T>
                                <T v="code" color="ink" flex={1} minWidth={0} userSelect="text">
                                  {match.text}
                                </T>
                              </XStack>
                            ))}
                          </YStack>
                        ))}
                      </YStack>
                    );
                  }

                  if (block.kind === 'media') {
                    const kindLabel = block.mediaKind === 'image' ? 'Image' : 'Audio';
                    const size = formatBytesCompact(block.sizeBytes);
                    const headline = [kindLabel, block.mimeType, size].filter(Boolean).join(' · ');
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        gap="1"
                        testID={`tool-output-media-${blockIndex}`}
                      >
                        <T v="metaStrong" color="ink">
                          {block.label ? `${headline} — ${block.label}` : headline}
                        </T>
                        <T v="meta" color="secondary">
                          {block.available
                            ? 'Media available in attachment.'
                            : 'Media bytes not stored in activity log'}
                        </T>
                      </YStack>
                    );
                  }

                  if (block.kind === 'resource') {
                    const size = formatBytesCompact(block.sizeBytes);
                    const modeLabel =
                      block.mode === 'link'
                        ? [block.mimeType ? `Link · ${block.mimeType}` : 'Link', '(not fetched)'].join(' ')
                        : block.mode === 'blob'
                          ? ['Blob', block.mimeType, size].filter(Boolean).join(' · ')
                          : ['Embedded text', block.mimeType].filter(Boolean).join(' · ');
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        gap="2"
                        testID={`tool-output-resource-${blockIndex}`}
                      >
                        <XStack justifyContent="space-between" alignItems="baseline" gap="2">
                          <T v="meta" color="secondary" flexShrink={0}>
                            Resource
                          </T>
                          <T v="metaStrong" color="ink" textAlign="right" flex={1} minWidth={0}>
                            {block.name ? `${block.name} · ${modeLabel}` : modeLabel}
                          </T>
                        </XStack>
                        {block.uri ? (
                          <T v="code" color="secondary" userSelect="text">
                            {block.uri}
                          </T>
                        ) : null}
                        {block.mode === 'blob' ? (
                          <T v="meta" color="secondary">
                            Binary resource bytes not stored in activity log
                          </T>
                        ) : null}
                        {block.mode === 'text' && block.text ? (
                          <YStack
                            paddingTop="2"
                            borderTopWidth={0.5}
                            borderTopColor="stroke"
                          >
                            <T v="code" color="ink" userSelect="text">
                              {block.text}
                            </T>
                          </YStack>
                        ) : null}
                      </YStack>
                    );
                  }

                  if (block.kind === 'unknown') {
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        gap="1"
                        testID={`tool-output-unknown-${blockIndex}`}
                      >
                        <T v="metaStrong" color="secondary">
                          {block.rawType ? `Unrecognized result block · ${block.rawType}` : 'Unrecognized result block'}
                        </T>
                        {block.text ? (
                          <T v="code" color="ink" userSelect="text">
                            {block.text}
                          </T>
                        ) : null}
                      </YStack>
                    );
                  }

                  if (block.kind === 'checklist') {
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        testID="tool-output-checklist"
                      >
                        {block.objective ? (
                          <YStack
                            paddingHorizontal="3"
                            paddingVertical="2"
                            borderBottomWidth={0.5}
                            borderBottomColor="stroke"
                          >
                            <T v="metaStrong" color="ink">
                              {block.objective}
                            </T>
                          </YStack>
                        ) : null}
                        {block.items.map((item, index) => (
                          <XStack
                            key={`${item.step}-${index}`}
                            alignItems="flex-start"
                            gap="2"
                            paddingHorizontal="3"
                            paddingVertical="2"
                            borderTopWidth={index > 0 ? 0.5 : 0}
                            borderTopColor="stroke"
                          >
                            <T
                              v="code"
                              color={item.status === 'pending' ? 'secondary' : 'ink'}
                              flexShrink={0}
                            >
                              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○'}
                            </T>
                            <T v="meta" color="ink" flex={1} minWidth={0} userSelect="text">
                              {item.step}
                            </T>
                          </XStack>
                        ))}
                      </YStack>
                    );
                  }

                  if (block.kind === 'empty') {
                    return (
                      <YStack
                        backgroundColor="raised"
                        borderWidth={1}
                        borderColor="stroke"
                        borderRadius="sm"
                        padding="3"
                        gap="2"
                        testID="tool-output-empty"
                      >
                        <T v="metaStrong" color="ink" testID="tool-output-text">
                          {block.heading}
                        </T>
                        {block.detail || block.chips?.length ? (
                          <XStack flexWrap="wrap" alignItems="center" gap="1">
                            {block.detail ? (
                              <T v="meta" color="secondary">
                                {block.detail}
                              </T>
                            ) : null}
                            {(block.chips ?? []).map((chip, index) => (
                              <YStack
                                key={`${chip}-${index}`}
                                backgroundColor="highlight"
                                borderRadius="sm"
                                paddingHorizontal="2"
                                paddingVertical="0.5"
                              >
                                <T v="code" color="ink">
                                  {chip}
                                </T>
                              </YStack>
                            ))}
                          </XStack>
                        ) : null}
                      </YStack>
                    );
                  }

                  if (block.kind === 'array-cards') {
                    const visibleArrayCards = showAllCards ? block.cards : block.cards.slice(0, INITIAL_ARRAY_CARDS);
                    const hiddenLocalCards = block.cards.length - visibleArrayCards.length;
                    return (
                      <YStack gap="2" testID="tool-output-array-cards">
                        {block.receipt ? (
                          <YStack
                            backgroundColor="raised"
                            borderWidth={1}
                            borderColor="stroke"
                            borderRadius="sm"
                            padding="3"
                            testID="tool-output-receipt"
                          >
                            <T v="meta" color="ink" userSelect="text">
                              {block.receipt}
                            </T>
                          </YStack>
                        ) : null}
                        {visibleArrayCards.map((card, index) => (
                          <YStack
                            key={`${card.lead}-${index}`}
                            backgroundColor="raised"
                            borderWidth={1}
                            borderColor="stroke"
                            borderRadius="sm"
                            paddingHorizontal="3"
                            paddingVertical="2"
                            gap="1"
                            testID={`tool-output-card-${index}`}
                          >
                            <XStack justifyContent="space-between" alignItems="baseline" gap="2">
                              <T v="metaStrong" color="ink" flex={1} minWidth={0} userSelect="text">
                                {card.lead}
                              </T>
                              {card.badge ? (
                                <T v="metaStrong" color="secondary" flexShrink={0}>
                                  {card.badge}
                                </T>
                              ) : null}
                            </XStack>
                            {card.meta ? (
                              <T v="meta" color="secondary" userSelect="text">
                                {card.meta}
                              </T>
                            ) : null}
                          </YStack>
                        ))}
                        {hiddenLocalCards > 0 ? (
                          <Button
                            size="inline"
                            label={`Show ${hiddenLocalCards} more`}
                            alignSelf="flex-start"
                            onPress={() => setShowAllCards(true)}
                            testID="tool-output-show-more"
                          />
                        ) : null}
                        {block.omittedCount ? (
                          <T v="meta" color="secondary" testID="tool-output-omitted-note">
                            {`+ ${block.omittedCount} more ${block.itemNoun} omitted at the 4 KiB step cap`}
                          </T>
                        ) : null}
                      </YStack>
                    );
                  }

                  if (block.kind === 'kv-card') {
                    return (
                      <YStack gap="2">
                        {block.receipt ? (
                          <YStack
                            backgroundColor="raised"
                            borderWidth={1}
                            borderColor="stroke"
                            borderRadius="sm"
                            padding="3"
                            testID="tool-output-receipt"
                          >
                            <T v="meta" color="ink" userSelect="text">
                              {block.receipt}
                            </T>
                          </YStack>
                        ) : null}
                        <YStack
                          backgroundColor="raised"
                          borderWidth={1}
                          borderColor="stroke"
                          borderRadius="sm"
                          testID="tool-output-kv-card"
                        >
                          {block.rows.map((row, index) => (
                            <YStack
                              key={`${row.key}-${index}`}
                              borderTopWidth={index > 0 ? 0.5 : 0}
                              borderTopColor="stroke"
                              paddingHorizontal="3"
                              paddingVertical="2"
                              gap="1"
                            >
                              {row.stacked ? (
                                <>
                                  <T v="meta" color="secondary">
                                    {row.key}
                                  </T>
                                  <T
                                    v={row.mono ? 'code' : 'meta'}
                                    color={row.muted ? 'secondary' : 'ink'}
                                    userSelect="text"
                                  >
                                    {row.value}
                                  </T>
                                </>
                              ) : (
                                <XStack justifyContent="space-between" alignItems="baseline" gap="3">
                                  <T v="meta" color="secondary" flexShrink={0}>
                                    {row.key}
                                  </T>
                                  <T
                                    v={row.mono ? 'code' : 'metaStrong'}
                                    color={row.muted ? 'secondary' : 'ink'}
                                    textAlign="right"
                                    flex={1}
                                    minWidth={0}
                                    userSelect="text"
                                  >
                                    {row.value}
                                  </T>
                                </XStack>
                              )}
                            </YStack>
                          ))}
                        </YStack>
                      </YStack>
                    );
                  }

                  if (block.kind === 'prose') {
                    return (
                      <YStack gap="2" testID="tool-output-prose">
                        <YStack backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="sm" padding="3" gap="2">
                          {block.paragraphs.map((paragraph, pIndex) => (
                            <T key={pIndex} v="body" color="ink" userSelect="text" testID={pIndex === 0 ? 'tool-output-text' : `tool-output-prose-${pIndex}`}>
                              {paragraph}
                            </T>
                          ))}
                          {block.links?.length ? (
                            <YStack paddingTop="2" borderTopWidth={0.5} borderTopColor="stroke" gap="1" testID="tool-output-prose-links">
                              {block.links.map((link, lIndex) => (
                                <T key={`${link.url}-${lIndex}`} v="code" color="secondary" userSelect="text">
                                  {link.label}
                                </T>
                              ))}
                            </YStack>
                          ) : null}
                        </YStack>
                      </YStack>
                    );
                  }

                  return (
                    <YStack gap="2">
                      {block.receipt ? (
                        <YStack backgroundColor="raised" borderWidth={1} borderColor="stroke" borderRadius="sm" padding="3" testID="tool-output-receipt">
                          <T v="meta" color="ink" userSelect="text">{block.receipt}</T>
                        </YStack>
                      ) : null}
                      <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1} testID="tool-output-text">
                        {block.text}
                      </T>
                    </YStack>
                  );
                  })()}
                </React.Fragment>
              ))}
            </YStack>
          )}
          {hasZone2Content && rawExpanded ? (
            <YStack
              gap="3"
              padding="3"
              backgroundColor="canvas"
              borderWidth={1}
              borderColor="stroke"
              borderRadius="sm"
              testID="tool-output-raw-panel"
            >
              {shownCommand ? (
                <YStack gap="1" testID="tool-output-command">
                  <T v="meta" color="secondary">
                    Command
                  </T>
                  <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1}>
                    {shownCommand}
                  </T>
                </YStack>
              ) : null}
              {shownInput ? (
                <YStack gap="1" testID="tool-output-input">
                  <T v="meta" color="secondary">
                    Arguments
                  </T>
                  <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1}>
                    {shownInput}
                  </T>
                </YStack>
              ) : null}
              {showRawOutputInZone2 ? (
                <YStack gap="1" testID="tool-output-raw-output">
                  <T v="meta" color="secondary">
                    Output
                  </T>
                  <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1}>
                    {rawZone2Output}
                  </T>
                </YStack>
              ) : null}
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
      {hasZone2Content || canCopy ? (
        <XStack
          justifyContent="space-between"
          alignItems="center"
          marginHorizontal="6"
          marginTop="2"
          paddingTop="2"
          borderTopWidth={0.5}
          borderTopColor="stroke"
          testID="tool-output-footer"
        >
          {hasZone2Content ? (
            <LedgerDisclosure
              expanded={rawExpanded}
              onPress={() => setRawExpanded((value) => !value)}
              accessibilityLabel={`${presentation.rawLabel}, expandable`}
              accessibilityState={{ expanded: rawExpanded }}
              rowTestID="tool-output-raw-toggle"
            >
              {presentation.rawLabel}
            </LedgerDisclosure>
          ) : (
            <YStack />
          )}
          {canCopy ? (
            <Button
              size="inline"
              alignSelf="center"
              label={copied ? 'Copied' : presentation.copyLabel}
              onPress={copy}
              testID="tool-output-copy"
            />
          ) : null}
        </XStack>
      ) : null}
    </HullActionSheetModal>
  );
}
