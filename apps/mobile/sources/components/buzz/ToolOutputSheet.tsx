import { ErrorBanner } from './ErrorBanner';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { typeRoles } from '@/buzz/groknight';
import { HULL_SHEET_INSET, HullActionSheetModal } from './HullActionSheet';
import { Button } from './Button';
import { CodeHighlighter } from './CodeHighlighter';

/** The source line every machine body is written to. */
const OUTPUT_COLUMNS = 80;
/** IBM Plex Mono advances 600/1000 of its em, so a column is 0.6 of the size. */
const MACHINE_ADVANCE = 0.6;
/**
 * A centred desktop sheet otherwise inherits the confirm dialog's cap, which
 * is narrower than the same sheet on a phone — so the one surface that exists
 * to show machine lines wrapped them soonest on the widest screen. It is
 * measured in columns of the text it holds instead.
 */
export const TOOL_OUTPUT_SHEET_MAX_WIDTH = Math.round(
  OUTPUT_COLUMNS * MACHINE_ADVANCE * typeRoles.machine.fontSize + HULL_SHEET_INSET * 2,
);

export type ToolOutputSheetProps = {
  title: string;
  subtitle?: string;
  detail: string | null | undefined;
  error?: string | null;
  outputHidden?: boolean;
  /**
   * When set, render Two Inks and wrap. Omitted for ordinary tool output,
   * which stays plain wrapped machine text.
   */
  language?: string | null;
  visible: boolean;
  onClose: () => void;
  testID?: string;
};

/**
 * Tool output surface: title, optional subtitle, a scrollable selectable
 * wrapping body, and a Copy row.
 */
export function ToolOutputSheet({
  title,
  subtitle,
  detail,
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
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    if (!detail || outputHidden) return;
    try {
      await (await import('expo-clipboard')).setStringAsync(detail);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [detail, outputHidden]);
  const canCopy = Boolean(detail && !outputHidden && detail !== 'Loading…' && !error);
  const highlight = language !== undefined;
  return (
    <HullActionSheetModal
      contentMaxWidth={TOOL_OUTPUT_SHEET_MAX_WIDTH}
      onClose={onClose}
      subtitle={subtitle}
      testID={testID}
      title={title}
      visible={visible}
    >
      <ScrollView
        nestedScrollEnabled
        flexGrow={0}
        flexShrink={1}
        maxHeight={Math.max(0, Math.round(windowHeight * 0.82) - 130 - insets.bottom)}
        testID="tool-output-scroll"
      >
        <YStack paddingHorizontal="6">
        {error ? <ErrorBanner inline title={error} /> : highlight ? (
          <CodeHighlighter code={detail ?? ''} language={language} />
        ) : (
          <T v="code" color="ink" userSelect="text" width="100%" minWidth={0} flexShrink={1} testID="tool-output-text">
            {detail || 'No output saved'}
          </T>
        )}
        </YStack>
      </ScrollView>
      {canCopy ? <Button
        size="inline"
        label={copied ? 'Copied' : 'Copy output'}
        alignSelf="flex-start"
        marginHorizontal="6"
        onPress={copy}
        testID="tool-output-copy"
      /> : null}
    </HullActionSheetModal>
  );
}
