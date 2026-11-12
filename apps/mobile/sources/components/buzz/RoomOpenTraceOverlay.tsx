/**
 * The Room-open trace, on screen.
 *
 * The timings were only ever written to the device log, which needs a cable and
 * developer tools, so the person who actually feels the app slow could never
 * read them. This paints the same run in the corner of the Room, small enough
 * to ignore and legible enough to screenshot.
 *
 * It renders nothing unless the build opted in with EXPO_PUBLIC_ROOM_OPEN_TRACE
 * AND the device's Settings debug toggle (roomOpenTraceOverlay) is on, which
 * is off by default on every device. The measurement keeps running when the
 * build carries the flag; nothing paints until the toggle is switched on, and
 * the flip takes effect immediately without a restart.
 */
import React from 'react';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { useLocalSetting } from '@/sync/storage';
import {
  observeRoomOpenTrace,
  roomOpenElapsed,
  roomOpenTraceEnabled,
} from '@/buzz/room-open-trace';

export function RoomOpenTraceOverlay({ testID }: { testID?: string }) {
  const buildEnabled = roomOpenTraceEnabled();
  const debugToggle = useLocalSetting('roomOpenTraceOverlay');
  const enabled = buildEnabled && debugToggle;
  const [rows, setRows] = React.useState<Array<{ phase: string; ms: number }>>([]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    return observeRoomOpenTrace((run) => setRows(roomOpenElapsed(run)));
  }, [enabled]);

  if (!enabled || rows.length === 0) return null;
  const total = rows[rows.length - 1]?.ms ?? 0;

  return (
    <YStack
      pointerEvents="none"
      position="absolute"
      top={4}
      right={4}
      maxWidth="86%"
      padding="1"
      borderRadius="sm"
      backgroundColor="raised"
      opacity={0.94}
      testID={testID ?? 'room-open-trace'}
    >
      {/* Type styles, not raw sizes: a diagnostic is not a licence to invent a text size. */}
      <T v="meta" color="needsYou">open {total}ms</T>
      {rows.map((row, index) => {
        // The gap from the previous mark is the number that matters: it is the
        // cost of that step, not the running total.
        const previous = index === 0 ? 0 : (rows[index - 1]?.ms ?? 0);
        return (
          <T v="code" color="secondary" key={`${row.phase}-${index}`}>
            {`${String(row.ms).padStart(5)}  +${String(row.ms - previous).padStart(4)}  ${row.phase}`}
          </T>
        );
      })}
    </YStack>
  );
}
