import React from 'react';
import { AtMark, Spinner } from '@/ui/grammar';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';

export function WorkflowWorkingMark({ waiting, viewerHolds, size = 20, testID }: {
  waiting: boolean; viewerHolds: boolean; size?: number; testID?: string;
}) {
  if (viewerHolds) return <AtMark size={size} />;
  if (waiting) return <WorkStateMark state="in-progress" />;
  return <Spinner size={size} testID={testID} accessibilityLabel="Running" />;
}
