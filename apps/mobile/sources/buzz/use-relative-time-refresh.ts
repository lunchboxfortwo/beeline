import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { afterFirstFrame } from '@/navigation/initial-landing';

const AGE_TICK_MS = 60_000;

/** Index ages refresh once a minute while focused, and after the first frame on return. */
export function useRelativeTimeRefresh(
  setNow: (now: number) => void,
  onRefresh?: () => void,
  onFocus?: () => (() => void),
): void {
  useFocusEffect(useCallback(() => {
    const blur = onFocus?.();
    // Returning to a retained list must paint before catch-up work or age changes.
    const cancelFrame = afterFirstFrame(() => {
      onRefresh?.();
      setNow(Date.now());
    });
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => {
      blur?.();
      cancelFrame();
      clearInterval(timer);
    };
  }, [setNow, onRefresh, onFocus]));
}
