import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from 'tamagui';
import type { WorkPriority, WorkState } from '@beeline/api-contract/phone';

export function WorkStateMark({ state }: { state: WorkState }) {
  const t = useTheme();
  const color = state === 'backlog' ? t.secondary!.val : t.ink!.val;
  return (
    <Svg width={18} height={18} viewBox="0 0 20 20" accessibilityLabel={state}>
      <Circle
        cx={10}
        cy={10}
        r={8}
        fill={state === 'done' ? color : 'none'}
        stroke={color}
        strokeWidth={1.7}
        strokeDasharray={state === 'backlog' ? '2.3 2.3' : undefined}
      />
      {state === 'needs-you' ? (
        <Path
          d="M4.5 15.5L15.5 4.5"
          fill="none"
          stroke={color}
          strokeWidth={1.7}
          strokeLinecap="round"
        />
      ) : null}
      {state === 'in-progress' ? <Path d="M10 4a6 6 0 0 1 0 12Z" fill={color} /> : null}
      {state === 'in-review' ? <Path d="M10 4a6 6 0 1 1-6 6h6Z" fill={color} /> : null}
      {state === 'done' ? (
        <Path
          d="m6 10 2.7 2.7L14 7.5"
          fill="none"
          stroke={t.canvas!.val}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </Svg>
  );
}
export function WorkPriorityMark({ priority }: { priority: WorkPriority }) {
  const t = useTheme();
  const bars = { high: 3, medium: 2, low: 1, none: 0, urgent: 0 }[priority];
  return (
    <Svg width={18} height={18} viewBox="0 0 20 20" accessibilityLabel={`${priority} priority`}>
      {priority === 'urgent' ? (
        <>
          <Rect x={2} y={2} width={16} height={16} rx={3} fill={t.needsYou!.val} />
          <Path d="M10 5.5v5.5" stroke={t.canvas!.val} strokeWidth={1.8} />
          <Circle cx={10} cy={14} r={1} fill={t.canvas!.val} />
        </>
      ) : priority === 'none' ? (
        [5, 10, 15].map((x) => <Circle key={x} cx={x} cy={11} r={1.4} fill={t.ink!.val} />)
      ) : (
        [0, 1, 2].map((i) => (
          <Rect
            key={i}
            x={3 + i * 5}
            y={13 - i * 4}
            width={3.5}
            height={4 + i * 4}
            rx={1}
            fill={t.ink!.val}
            opacity={i < bars ? 1 : 0.18}
          />
        ))
      )}
    </Svg>
  );
}
