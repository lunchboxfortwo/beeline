import { ErrorBanner } from './ErrorBanner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { typeRoles } from '@/buzz/groknight';
import type { ToolIdentityLookup } from '@/buzz/tool-identity-lookup';
import { buildToolSheetPresentation } from '@/buzz/tool-output-format';
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
  command?: string | null;
  input?: string | null;
  receipt?: string | null;
  detail: string | null | undefined;
  rawOutput?: string | null;
  files?: readonly { path: string; status?: string; diff?: string }[];
  plan?: {
    objective?: string;
    items: readonly { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
  };
  outcome?: 'running' | 'success' | 'failure';
  terminalOnly?: boolean;
  requester?: string;
  lookup?: ToolIdentityLookup;
  error?: string | null;
  outputHidden?: boolean;
  /**
   * When set, render Two Inks and wrap. Omitted for ordinary tool output,
   * which renders result-first structured cards or wrapped machine text.
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
 * Result-first tool output sheet: plain-English title + subtitle (+ Bounded/Truncated
 * badge), structured result body first (sent message card, key-value card, stacked
 * array cards, empty banner, colored unified diff, checklist, or unwrapped mono log),
 * and one collapsible `Raw … ⌄/⌃` + `Copy raw` footer.
 */
export function ToolOutputSheet({
  title,
  subtitle,
  command,
  input,
  receipt,
  detail,
  rawOutput,
  files,
  plan,
  outcome,
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

  useEffect(() => {
    setRawExpanded(false);
    setShowAllCards(false);
    setCopied(false);
  }, [visible, title, detail, rawOutput]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const presentation = useMemo(
    () =>
      buildToolSheetPresentation({
        title,
        subtitle,
        command,
        input,
        receipt,
        detail,
        rawOutput,
        files,
        plan,
        outcome,
        terminalOnly,
        outputHidden,
        requester,
        lookup,
      }),
    [
      title,
      subtitle,
      command,
      input,
      receipt,
      detail,
      rawOutput,
      files,
      plan,
      outcome,
      terminalOnly,
      outputHidden,
      requester,
      lookup,
    ],
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
  const hasRaw = Boolean(!outputHidden && !isLoading && !error && (shownCommand || shownInput || presentation.rawText));
  const body = presentation.body;
  const visibleArrayCards =
    body.kind === 'array-cards'
      ? showAllCards
        ? body.cards
        : body.cards.slice(0, INITIAL_ARRAY_CARDS)
      : [];
  const hiddenLocalCards =
    body.kind === 'array-cards' ? body.cards.length - visibleArrayCards.length : 0;

  return (
    <HullActionSheetModal
      contentMaxWidth={TOOL_OUTPUT_SHEET_MAX_WIDTH}
      onClose={onClose}
      subtitle={presentation.subtitle}
      testID={testID}
      title={presentation.title}
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
          {presentation.badge ? (
            <XStack justifyContent="flex-start">
              <YStack
                paddingHorizontal="2"
                paddingVertical="0.5"
                borderRadius="sm"
                borderWidth={1}
                borderColor="needsYou"
                backgroundColor="raised"
                testID="tool-output-badge"
              >
                <T v="metaStrong" color="needsYou">
                  {presentation.badge}
                </T>
              </YStack>
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
          ) : body.kind === 'secret' ? (
            <YStack
              backgroundColor="raised"
              borderWidth={1}
              borderColor="stroke"
              borderRadius="sm"
              padding="3"
              testID="tool-output-secret"
            >
              <T v="meta" color="secondary" testID="tool-output-text">
                {body.notice}
              </T>
            </YStack>
          ) : body.kind === 'sent-message' ? (
            <YStack
              backgroundColor="raised"
              borderWidth={1}
              borderColor="stroke"
              borderRadius="sm"
              padding="3"
              gap="2"
              testID="tool-output-sent-message"
            >
              {body.fromTo || body.tag ? (
                <XStack
                  justifyContent="space-between"
                  alignItems="center"
                  paddingBottom="2"
                  borderBottomWidth={0.5}
                  borderBottomColor="stroke"
                >
                  <T v="meta" color="secondary">
                    {body.fromTo ?? ''}
                  </T>
                  <T v="meta" color="secondary">
                    {body.tag ?? ''}
                  </T>
                </XStack>
              ) : null}
              <T v="body" color="ink" userSelect="text" testID="tool-output-text">
                {body.text}
              </T>
            </YStack>
          ) : body.kind === 'diff' ? (
            <YStack gap="3" testID="tool-output-diff">
              {body.files.map((file, fileIndex) => (
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
                    gap="2"
                    paddingHorizontal="3"
                    paddingVertical="2"
                    backgroundColor="highlight"
                    borderBottomWidth={0.5}
                    borderBottomColor="stroke"
                  >
                    {file.status ? (
                      <T v="metaStrong" color="needsYou" flexShrink={0}>
                        {file.status}
                      </T>
                    ) : null}
                    <T v="code" color="secondary" flex={1} minWidth={0} numberOfLines={1}>
                      {file.path}
                    </T>
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
          ) : body.kind === 'checklist' ? (
            <YStack
              backgroundColor="raised"
              borderWidth={1}
              borderColor="stroke"
              borderRadius="sm"
              testID="tool-output-checklist"
            >
              {body.objective ? (
                <YStack
                  paddingHorizontal="3"
                  paddingVertical="2"
                  borderBottomWidth={0.5}
                  borderBottomColor="stroke"
                >
                  <T v="metaStrong" color="ink">
                    {body.objective}
                  </T>
                </YStack>
              ) : null}
              {body.items.map((item, index) => (
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
                    color={
                      item.status === 'completed'
                        ? 'added'
                        : item.status === 'in_progress'
                          ? 'needsYou'
                          : 'secondary'
                    }
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
          ) : body.kind === 'empty' ? (
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
                {body.heading}
              </T>
              {body.detail || body.chips?.length ? (
                <XStack flexWrap="wrap" alignItems="center" gap="1">
                  {body.detail ? (
                    <T v="meta" color="secondary">
                      {body.detail}
                    </T>
                  ) : null}
                  {(body.chips ?? []).map((chip, index) => (
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
          ) : body.kind === 'array-cards' ? (
            <YStack gap="2" testID="tool-output-array-cards">
              {body.receipt ? (
                <YStack
                  backgroundColor="raised"
                  borderWidth={1}
                  borderColor="stroke"
                  borderRadius="sm"
                  padding="3"
                  testID="tool-output-receipt"
                >
                  <T v="meta" color="ink" userSelect="text">
                    {body.receipt}
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
                      <T v="metaStrong" color="needsYou" flexShrink={0}>
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
              {body.omittedCount ? (
                <T v="meta" color="needsYou" testID="tool-output-omitted-note">
                  {`+ ${body.omittedCount} more ${body.itemNoun} omitted at the 4 KiB step cap`}
                </T>
              ) : null}
            </YStack>
          ) : body.kind === 'kv-card' ? (
            <YStack gap="2">
              {body.receipt ? (
                <YStack
                  backgroundColor="raised"
                  borderWidth={1}
                  borderColor="stroke"
                  borderRadius="sm"
                  padding="3"
                  testID="tool-output-receipt"
                >
                  <T v="meta" color="ink" userSelect="text">
                    {body.receipt}
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
                {body.rows.map((row, index) => (
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
          ) : (
            <YStack gap="2">
              {body.receipt ? (
                <YStack
                  backgroundColor="raised"
                  borderWidth={1}
                  borderColor="stroke"
                  borderRadius="sm"
                  padding="3"
                  testID="tool-output-receipt"
                >
                  <T v="meta" color="ink" userSelect="text">
                    {body.receipt}
                  </T>
                </YStack>
              ) : null}
              <T
                v="code"
                color="ink"
                userSelect="text"
                width="100%"
                minWidth={0}
                flexShrink={1}
                testID="tool-output-text"
              >
                {body.text}
              </T>
            </YStack>
          )}
          {hasRaw && rawExpanded ? (
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
              {presentation.rawText && !shownCommand && !shownInput ? (
                <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1}>
                  {presentation.rawText}
                </T>
              ) : rawOutput || detail ? (
                <YStack gap="1" testID="tool-output-raw-output">
                  <T v="meta" color="secondary">
                    Output
                  </T>
                  <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1}>
                    {rawOutput ?? detail}
                  </T>
                </YStack>
              ) : null}
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
      {hasRaw || canCopy ? (
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
          {hasRaw ? (
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
              label={copied ? 'Copied' : 'Copy raw'}
              onPress={copy}
              testID="tool-output-copy"
            />
          ) : null}
        </XStack>
      ) : null}
    </HullActionSheetModal>
  );
}
