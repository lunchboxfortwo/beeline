import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from 'tamagui';
import type { WorkState } from '@beeline/api-contract/phone';

/** One status glyph for Tasks and Chats: pause, half, three-quarter, idle ring, dashed, check.
 * Waiting (pause) is brass, ring and bars; every other state is ink. */
export function WorkStateMark({ state, idle = false }: { state: WorkState; idle?: boolean }) {
  const t = useTheme();
  const ink = state === 'needs-you' ? t.waiting!.val : t.ink!.val;
  const ring = (
    <Circle
      cx={10}
      cy={10}
      r={8.2}
      fill="none"
      stroke={ink}
      strokeWidth={1.7}
      strokeDasharray={state === 'backlog' ? '2.2 2.6' : undefined}
    />
  );
  const label = idle && state === 'in-progress' ? 'idle' : state;
  return (
    <Svg width={18} height={18} viewBox="0 0 20 20" accessibilityLabel={label}>
      {state === 'done' ? (
        <>
          <Circle cx={10} cy={10} r={9} fill={ink} />
          <Path
            d="M5.8 10.3l2.9 2.9 5.6-5.8"
            fill="none"
            stroke={t.canvas!.val}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        ring
      )}
      {state === 'needs-you' ? (
        <>
          <Rect x={6.6} y={6} width={2} height={8} rx={1} fill={ink} />
          <Rect x={11.4} y={6} width={2} height={8} rx={1} fill={ink} />
        </>
      ) : null}
      {state === 'in-progress' && !idle ? <Path d="M10 1.8A8.2 8.2 0 0 0 10 18.2Z" fill={ink} /> : null}
      {state === 'in-review' ? <Path d="M10 10V1.8A8.2 8.2 0 1 1 1.8 10Z" fill={ink} /> : null}
    </Svg>
  );
}
