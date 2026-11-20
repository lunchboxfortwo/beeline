import React from 'react';
import { WorkflowStepCircle } from '@/components/buzz/WorkflowStepCircle';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import { XStack, YStack } from 'tamagui';
import { AtMark, Spinner } from '@/ui/grammar';

export type ConnectStepState = 'done' | 'current' | 'waiting' | 'todo' | 'failed';
export type ConnectBarPart = 'filled' | 'active' | 'failed' | 'empty';

export function StepDot({ state, testID }: { state: ConnectStepState; testID?: string }) {
    return (
        <YStack width={28} height={28} alignItems="center" justifyContent="center" testID={testID}>
            {state === 'done' ? <WorkStateMark state="done" />
                : state === 'failed' ? <WorkflowStepCircle status="failed" />
                    : state === 'current' ? <Spinner />
                        : state === 'waiting' ? <AtMark /> : <WorkStateMark state="in-progress" idle />}
        </YStack>
    );
}

/** The step bar: one segment per step, brass up to the current one. */
export function StepBar({ parts, testID }: { parts: readonly ConnectBarPart[]; testID?: string }) {
    return (
        <XStack gap="1" testID={testID}>
            {parts.map((part, index) => (
                <YStack key={index} flex={1} height={4} borderRadius="full"
                    backgroundColor={part === 'empty' ? 'stroke' : 'needsYou'}
                    opacity={part === 'active' ? 0.6 : 1} />
            ))}
        </XStack>
    );
}
