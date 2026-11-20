import React from 'react';
import { YStack } from 'tamagui';
import { Spinner } from '@/ui/grammar';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import { WorkflowStepCircle } from './WorkflowStepCircle';

export type StateDotKind = 'live' | 'pulse' | 'failed';

export function StateDot({ kind, testID }: { kind: StateDotKind; testID?: string }) {
  if (kind === 'pulse') return <Spinner size={12} testID={testID ? `${testID}-pulse` : undefined} />;
  return (
    <YStack testID={testID ? `${testID}-${kind}` : undefined}>
      {kind === 'live' ? <WorkStateMark state="done" size={12} /> : <WorkflowStepCircle status="failed" size={12} />}
    </YStack>
  );
}
