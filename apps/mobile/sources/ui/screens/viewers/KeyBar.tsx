import React from 'react';
import { Input, XStack, YStack } from 'tamagui';
import { Clipboard, X } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';

/** The page keys, by their DOM `KeyboardEvent.key` names. */
export const BROWSER_KEYS: readonly { label: string; key: string; name: string }[] = [
    { label: 'Esc', key: 'Escape', name: 'Escape' },
    { label: 'Tab', key: 'Tab', name: 'Tab' },
    { label: '⌫', key: 'Backspace', name: 'Backspace' },
    { label: 'Enter', key: 'Enter', name: 'Enter' },
    { label: '←', key: 'ArrowLeft', name: 'Left arrow' },
    { label: '↑', key: 'ArrowUp', name: 'Up arrow' },
    { label: '↓', key: 'ArrowDown', name: 'Down arrow' },
    { label: '→', key: 'ArrowRight', name: 'Right arrow' },
];

/**
 * What one edit of the field sends to the page: the characters removed from
 * its end as Backspaces, then the new characters as text. The field mirrors
 * what was typed into the page's focused field since the bar opened.
 */
export function fieldEdits(previous: string, next: string): { backspaces: number; text: string } {
    let common = 0;
    while (common < previous.length && common < next.length && previous[common] === next[common]) common += 1;
    return { backspaces: previous.length - common, text: next.slice(common) };
}

/**
 * The shared browser's key bar (decision 19, frame r12-browser-keys): a field
 * that types into the page's focused field, then Esc, Tab, ⌫, Enter, the
 * arrows and Paste (this phone's clipboard).
 */
export function KeyBar({ onText, onKey, onPaste, onClose }: {
    onText: (text: string) => void;
    onKey: (key: string) => void;
    onPaste: () => void;
    onClose: () => void;
}) {
    const [typed, setTyped] = React.useState('');
    const [last, setLast] = React.useState('');
    const key = (entry: { key: string; name: string }) => {
        onKey(entry.key);
        setLast(entry.name);
        if (entry.key === 'Backspace') setTyped((value) => value.slice(0, -1));
        if (entry.key === 'Enter') setTyped('');
    };
    return (
        <YStack paddingHorizontal="3" paddingBottom="2" gap="2" testID="computer-session-key-bar">
            <XStack gap="2" alignItems="center">
                <Input
                    flex={1}
                    minWidth={0}
                    minHeight={HEIGHT.control}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Type into the page"
                    aria-label="Type into the shared page"
                    accessibilityLabel="Type into the shared page"
                    value={typed}
                    onChangeText={(next: string) => {
                        const edit = fieldEdits(typed, next);
                        for (let index = 0; index < edit.backspaces; index += 1) onKey('Backspace');
                        if (edit.text) onText(edit.text);
                        setTyped(next);
                        setLast('');
                    }}
                    onSubmitEditing={() => key({ key: 'Enter', name: 'Enter' })}
                    testID="computer-session-key-field"
                />
                <Btn kind="icon" label="Hide keyboard controls" onPress={onClose} testID="computer-session-key-bar-close"><Glyph icon={X} size={16} /></Btn>
            </XStack>
            <XStack gap="1" flexWrap="wrap">
                {BROWSER_KEYS.map((entry) => (
                    <Btn key={entry.key} kind="secondary" label={`Send ${entry.name}`} minWidth={HEIGHT.control} paddingHorizontal="2"
                        onPress={() => key(entry)} testID={`computer-session-key-${entry.key}`}>
                        <T v="metaStrong">{entry.label}</T>
                    </Btn>
                ))}
                <Btn kind="secondary" label="Paste from phone" paddingHorizontal="2" testID="computer-session-key-paste"
                    onPress={() => { onPaste(); setLast('Paste'); }}>
                    <XStack gap="1" alignItems="center"><Glyph icon={Clipboard} size={16} color="ink" /><T v="metaStrong">Paste</T></XStack>
                </Btn>
            </XStack>
            <Copy small quiet testID="computer-session-key-sent">{last ? `Sent ${last} to the page` : 'Typing goes to the focused field on the page.'}</Copy>
        </YStack>
    );
}
