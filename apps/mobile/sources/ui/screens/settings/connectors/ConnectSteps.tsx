import React from 'react';
import { Spinner, XStack, YStack } from 'tamagui';
import { Check, X } from 'lucide-react-native';
import { Glyph, T } from '@/ui/grammar';

export type ConnectStepState = 'done' | 'current' | 'waiting' | 'todo' | 'failed';
export type ConnectBarPart = 'filled' | 'active' | 'failed' | 'empty';

/** One step's mark: a check when done, a spinner while running, its number otherwise. */
export function StepDot({ state, number, testID }: { state: ConnectStepState; number: number; testID?: string }) {
    return (
        <YStack width={28} height={28} borderRadius="full" borderWidth={1} alignItems="center" justifyContent="center" testID={testID}
            borderColor={state === 'failed' ? 'removed' : state === 'todo' ? 'strongStroke' : 'needsYou'}>
            {state === 'done' ? <Glyph icon={Check} size={16} accent />
                : state === 'failed' ? <Glyph icon={X} size={16} color="removed" />
                    : state === 'current' ? <Spinner size="small" color="needsYou" />
                        : <T v="metaStrong" color={state === 'waiting' ? 'needsYou' : 'secondary'}>{number}</T>}
        </YStack>
    );
}

/** The step bar: one segment per step, brass up to the current one. */
export function StepBar({ parts, testID }: { parts: readonly ConnectBarPart[]; testID?: string }) {
    return (
        <XStack gap="1" testID={testID}>
            {parts.map((part, index) => (
                <YStack key={index} flex={1} height={4} borderRadius="full"
                    backgroundColor={part === 'failed' ? 'removed' : part === 'empty' ? 'stroke' : 'needsYou'}
                    opacity={part === 'active' ? 0.6 : 1} />
            ))}
        </XStack>
    );
}
