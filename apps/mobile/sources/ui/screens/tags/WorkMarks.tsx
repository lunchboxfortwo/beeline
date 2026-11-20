import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from 'tamagui';
import type { WorkState } from '@beeline/api-contract/phone';
import { AtMark, MARK } from '@/ui/grammar';

/**
 * One status glyph for Tasks, Chats and threads. The circle is the task and how full it is says
 * how far along: dashed ring backlog, empty ring idle, half working, three quarters in review, a
 * full disc in the ring done. Fills sit inside the ring and grow clockwise from the top. Needs
 * you is the @ fitted to the ring. Working right now (a running turn, a load) is the `Spinner`.
 */
export function WorkStateMark({ state, idle = false, size = MARK }: { state: WorkState; idle?: boolean; size?: number }) {
  const ink = useTheme().needsYou?.val as string;
  if (state === 'needs-you') return <AtMark size={size} />;
  const label = idle && state === 'in-progress' ? 'idle' : state === 'in-progress' ? 'working' : state === 'in-review' ? 'in review' : state;
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" accessibilityLabel={label}>
      <Circle
        cx={10}
        cy={10}
        r={8.2}
        fill="none"
        stroke={ink}
        strokeWidth={1.7}
        strokeDasharray={state === 'backlog' ? '2.2 2.6' : undefined}
      />
      {state === 'in-progress' && !idle ? <Path d="M10 4.6A5.4 5.4 0 0 1 10 15.4Z" fill={ink} /> : null}
      {state === 'in-review' ? <Path d="M10 10V4.6A5.4 5.4 0 1 1 4.6 10Z" fill={ink} /> : null}
      {state === 'done' ? <Circle cx={10} cy={10} r={5.4} fill={ink} /> : null}
    </Svg>
  );
}
