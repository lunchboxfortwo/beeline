import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Href } from 'expo-router';
import { XStack, YStack } from 'tamagui';
import { Inked, T } from '@/ui/grammar';
import { CodeHighlighter } from '@/components/buzz/CodeHighlighter';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import {
  fenceInscription,
  hiddenLineLabel,
  isLongFence,
  isPlainTextFence,
  PEEK_LINE_COUNT,
} from '@/buzz/code-fence';
export {
  fenceByteLength,
  fenceInscription,
  formatFenceBytes,
  hiddenLineLabel,
  isLongFence,
  isPlainTextFence,
  PEEK_LINE_COUNT,
} from '@/buzz/code-fence';

export function codeArtifactHref({
  roomId,
  messageId,
  blockIndex,
}: {
  roomId: string;
  messageId: string;
  blockIndex: number;
}): Href {
  return {
    pathname: '/artifact-viewer',
    params: {
      roomId,
      messageId,
      blockIndex: String(blockIndex),
    },
  } as Href;
}

export function CodeBlock({
  code,
  language,
  roomId,
  messageId,
  blockIndex,
  onOpen,
}: {
  code: string;
  language: string | null;
  roomId?: string;
  messageId?: string;
  blockIndex?: number;
  onOpen?: (messageId: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = useMemo(() => code.split('\n'), [code]);
  const plainText = isPlainTextFence(language);
  const long = isLongFence(code);
  const routed = Boolean(roomId && messageId && blockIndex !== undefined);
  const inscription = useMemo(() => fenceInscription(language, code), [language, code]);
  const peek = useMemo(
    () => (long && routed ? lines.slice(0, PEEK_LINE_COUNT).join('\n') : code),
    [code, lines, long, routed],
  );
  const hidden = hiddenLineLabel(lines.length);
  const sheetTitle = (language?.trim() || (plainText ? 'text' : 'code')).toLowerCase();

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copyAll = useCallback(async () => {
    try {
      await (await import('expo-clipboard')).setStringAsync(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2_000);
  }, [code]);

  const copyLabel =
    copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'copy';

  const openReader = useCallback(async () => {
    if (!roomId || !messageId || blockIndex === undefined) return;
    onOpen?.(messageId);
    const { router } = await import('expo-router');
    router.push(codeArtifactHref({ roomId, messageId, blockIndex }));
  }, [blockIndex, messageId, onOpen, roomId]);

  const [peekPressed, setPeekPressed] = useState(false);
  const body = plainText ? (
    <T v="code" userSelect="text" width="100%" minWidth={0} testID="plain-text-fence">
      {peek}
    </T>
  ) : (
    <CodeHighlighter code={peek} language={language} />
  );
  const copy = (
    <CopyVerb
      accessibilityLabel={plainText ? 'Copy all text' : 'Copy all code'}
      label={copyLabel}
      onPress={copyAll}
    />
  );

  return (
    <YStack maxWidth="100%" minWidth={0} paddingLeft="2" paddingRight="2" paddingVertical="1" borderLeftWidth={2} borderLeftColor="secondary">
      {long && routed ? (
        <XStack alignItems="center" justifyContent="space-between" gap="2" marginBottom="2">
          <T v="code" color="secondary" numberOfLines={1} flexShrink={1} testID="code-inscription">
            {inscription}
          </T>
          {copy}
        </XStack>
      ) : (
        <YStack height={0} alignItems="flex-end" zIndex={1} pointerEvents="box-none">
          {copy}
        </YStack>
      )}
      {long && routed ? (
        <YStack
          accessibilityLabel={`Open ${sheetTitle}, ${hidden}`}
          accessibilityRole="button"
          onPress={openReader}
          onPressIn={() => setPeekPressed(true)}
          onPressOut={() => setPeekPressed(false)}
          cursor="pointer"
          minWidth={0}
          opacity={peekPressed ? 0.58 : 1}
          testID="code-open"
        >
          {body}
          <XStack alignItems="center" gap="2" marginTop="1" paddingVertical="0.5">
            <Inked color="needsYou" glyph={ChevronGlyph} direction="down" size={CHEVRON_ROW_SIZE} />
            <T v="metaStrong" color="needsYou" textTransform="uppercase">open</T>
            <T v="code" color="secondary">{hidden}</T>
          </XStack>
        </YStack>
      ) : (
        body
      )}
    </YStack>
  );
}

/** The brass copy verb over a fence: the label is the copy state, read politely. */
function CopyVerb({ accessibilityLabel, label, onPress }: { accessibilityLabel: string; label: string; onPress: () => void }) {
  const [pressed, setPressed] = useState(false);
  return (
    <YStack
      accessibilityLiveRegion="polite"
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      cursor="pointer"
      justifyContent="center"
      paddingLeft="2"
      opacity={pressed ? 0.58 : 1}
    >
      <T v="metaStrong" color="needsYou" textTransform="uppercase">{label}</T>
    </YStack>
  );
}
