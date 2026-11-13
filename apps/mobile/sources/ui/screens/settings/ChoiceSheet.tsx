import React from 'react';
import { YStack } from 'tamagui';
import { Check } from 'lucide-react-native';
import { Glyph, SheetFrame, SheetRow } from '@/ui/grammar';

type Choice<V> = { value: V; label: string; detail?: string };

/** One setting's choices as a sheet: a tick marks the current one; a tap saves and closes. */
export function ChoiceSheet<V extends string | number>({ open, close, title, choices, value, onChoose, testID }: {
    open: boolean; close: () => void; title: string; choices: readonly Choice<V>[]; value: V;
    onChoose: (value: V) => void; testID?: string;
}) {
    return (
        <SheetFrame open={open} close={close} title={title} testID={testID}>
            <YStack>
                {choices.map((choice) => (
                    <SheetRow
                        key={String(choice.value)}
                        icon={choice.value === value ? <Glyph icon={Check} accent /> : null}
                        label={choice.label}
                        detail={choice.detail}
                        onPress={() => { close(); if (choice.value !== value) onChoose(choice.value); }}
                        testID={testID ? `${testID}-${choice.value}` : undefined}
                    />
                ))}
            </YStack>
        </SheetFrame>
    );
}
