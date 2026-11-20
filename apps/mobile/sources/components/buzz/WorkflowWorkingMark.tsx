import React from 'react';
import type { WorkflowActorView } from '@beeline/api-contract/phone';
import type { WorkflowLineKind } from '@/buzz/workflow-graph';
import { AtMark, Spinner } from '@/ui/grammar';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';

export function WorkflowWorkingMark({ kind, holder, viewerHolds, size = 20, testID }: {
  kind: WorkflowLineKind | undefined; holder?: WorkflowActorView; viewerHolds: boolean; size?: number; testID?: string;
}) {
  if (viewerHolds) return <AtMark size={size} />;
  if (kind === 'gate' || kind === 'waiting' || holder?.kind === 'human') return <WorkStateMark state="in-progress" size={size} />;
  return <Spinner size={size} testID={testID} accessibilityLabel="Running" />;
}
