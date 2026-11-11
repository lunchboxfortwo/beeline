import React from 'react';
import { TamaguiProvider, Theme } from 'tamagui';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSetting } from '@/sync/storage';
import { tamaguiConfig, themeName } from './tamagui.config';

/** Mounts the grammar's theme: Obsidian or Bone from Appearance, Brass or Stone from Color set. */
export function GrammarProvider({ children }: { children: React.ReactNode }) {
    const { theme } = useUnistyles();
    const palette = useLocalSetting('palette');
    const name = themeName(theme.dark ? 'dark' : 'light', palette);
    return (
        <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
            <Theme name={name}>{children}</Theme>
        </TamaguiProvider>
    );
}
