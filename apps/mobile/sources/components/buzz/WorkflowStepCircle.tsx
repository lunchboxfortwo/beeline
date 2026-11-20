import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { YStack, useTheme } from 'tamagui';
import type { WorkflowLineStatus } from '@/buzz/workflow-graph';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';

export function WorkflowStepCircle({ status, size = 20, testID }: {
  status: WorkflowLineStatus; size?: number; testID?: string;
}) {
  const ink = useTheme().needsYou?.val as string;
  return (
    <YStack width={size} height={size} testID={testID}>
      {status === 'failed' ? (
        <Svg width={size} height={size} viewBox="0 0 20 20" accessibilityLabel="failed">
          <Circle cx={10} cy={10} r={8.2} fill="none" stroke={ink} strokeWidth={1.7} />
          <Path d="M7 7l6 6M13 7l-6 6" stroke={ink} strokeLinecap="round" strokeWidth={1.6} />
        </Svg>
      ) : <WorkStateMark state={status === 'done' ? 'done' : 'in-progress'} idle={status === 'pending'} size={size} />}
    </YStack>
  );
}
