import { IndexRow, InlineRow } from './IndexRow';
import React, { useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { YStack } from 'tamagui';
import { STEP, T } from '@/ui/grammar';
import {
  cornerOpensListed,
  listCornerOpens,
  useCornerOpenStatus,
  type CornerOpenStatus,
} from '@/buzz/corner-open-status';
import { CORNER_LABEL } from '@/buzz/vocabulary';

/** Whole seconds a pending create has waited, ticking once a second. */
export function useCornerOpenSeconds(status: CornerOpenStatus): number {
  const startedAt = status.status === 'pending' ? status.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The pending line under "Opening corner…": the wait, or the second-tap answer. */
export function cornerOpenWaitLine(status: CornerOpenStatus, seconds: number): string {
  if (status.status !== 'pending') return '';
  return status.again ? 'Still opening…' : `Waiting for server · ${seconds}s`;
}

/** Pending corner creation is visible here; request failures use the app banner. */
export function CornerOpenToast() {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  const insets = useSafeAreaInsets();
  if (status.status !== 'pending' || cornerOpensListed(status.roomId)) return null;
  return (
    <YStack pointerEvents="box-none" position="absolute" left={STEP['4']} right={STEP['4']} bottom={insets.bottom + STEP['4']}>
      <InlineRow
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        alignItems="center"
        gap="4"
        padding="4"
        borderRadius="sm"
        borderWidth={1}
        borderColor="strongStroke"
        backgroundColor="canvas"
        testID='corner-open-pending'
      >
        <YStack flex={1}>
          <T v="body">
            {`Opening ${CORNER_LABEL}…`}
          </T>
          <T v="meta" color="secondary">
            {cornerOpenWaitLine(status, seconds)}
          </T>
        </YStack>
      </InlineRow>
    </YStack>
  );
}

/** The Corners page shows only its pending create, without a second failure row. */
export function CornerOpenRow({ roomId }: { roomId: string }) {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  useEffect(() => listCornerOpens(roomId), [roomId]);
  if (status.status !== 'pending' || status.roomId !== roomId) return null;
  return <IndexRow title={`Opening ${CORNER_LABEL}…`} description={cornerOpenWaitLine(status, seconds)} testID="corner-open-row-pending" />;
}
