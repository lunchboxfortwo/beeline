import * as React from 'react';
import { Platform } from 'react-native';
import { XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import {
    formatShortcut,
    GLOBAL_SHORTCUTS,
    GlobalShortcutId,
    ShortcutModifier,
} from '@/keyboard/shortcuts';

interface ShortcutHintsContextValue {
    modifier: ShortcutModifier | null;
    visible: boolean;
    browserSafeShortcuts: boolean;
    sessionShortcutNumbers: Readonly<Record<string, number>>;
}

const EMPTY_SESSION_SHORTCUT_NUMBERS: Readonly<Record<string, number>> = {};

const ShortcutHintsContext = React.createContext<ShortcutHintsContextValue>({
    modifier: null,
    visible: false,
    browserSafeShortcuts: false,
    sessionShortcutNumbers: EMPTY_SESSION_SHORTCUT_NUMBERS,
});

const shortcutLabels: Record<GlobalShortcutId, () => string> = {
    newSession: () => "New session",
    settings: () => "Settings",
};

export function ShortcutHintsProvider({
    modifier,
    recentSessionIds,
    browserSafeShortcuts,
    children,
}: {
    modifier: ShortcutModifier | null;
    recentSessionIds: readonly string[];
    browserSafeShortcuts: boolean;
    children: React.ReactNode;
}) {
    const visible = Platform.OS === 'web' && modifier !== null;
    const sessionShortcutNumbers = React.useMemo(() => visible
        ? Object.fromEntries(recentSessionIds.map((sessionId, index) => [sessionId, index + 1]))
        : EMPTY_SESSION_SHORTCUT_NUMBERS,
    [recentSessionIds, visible]);
    const value = React.useMemo(() => ({
        modifier,
        visible,
        browserSafeShortcuts,
        sessionShortcutNumbers,
    }), [browserSafeShortcuts, modifier, visible, sessionShortcutNumbers]);

    return (
        <ShortcutHintsContext.Provider value={value}>
            {children}
            {visible && modifier && (
                <XStack
                    pointerEvents="none"
                    position="absolute"
                    right={24}
                    bottom={24}
                    zIndex={2000}
                    flexWrap="wrap"
                    justifyContent="flex-end"
                    gap="2"
                    maxWidth={520}
                    padding="2"
                    borderRadius="md"
                    borderWidth={1}
                    borderColor="strongStroke"
                    backgroundColor="raised"
                    testID="shortcut-hints-overlay"
                >
                    {GLOBAL_SHORTCUTS
                        .map((shortcut) => (
                            <XStack key={shortcut.id} alignItems="center" gap="2" paddingVertical="1" paddingHorizontal="2" borderRadius="md" backgroundColor="highlight">
                                <YStack minWidth={30} alignItems="center" justifyContent="center" paddingHorizontal="2" paddingVertical="1" borderRadius="md" borderWidth={1} borderColor="stroke" backgroundColor="canvas">
                                    <T v="code">
                                        {formatShortcut(modifier, shortcut.keyLabel, browserSafeShortcuts)}
                                    </T>
                                </YStack>
                                <T v="metaStrong">{shortcutLabels[shortcut.id]()}</T>
                            </XStack>
                        ))}
                </XStack>
            )}
        </ShortcutHintsContext.Provider>
    );
}
