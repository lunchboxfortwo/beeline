import React from 'react';
import { TamaguiProvider, Theme } from 'tamagui';
import { useAppMode } from '@/display';
import { useLocalSetting } from '@/sync/storage';
import { TextSizeContext } from './grammar';
import { tamaguiConfig, themeName } from './tamagui.config';

/**
 * Mounts the grammar's theme (Obsidian or Bone from Appearance, Brass or Stone
 * from Color set) and its text size (Settings → You → Text size).
 */
export function GrammarProvider({ children }: { children: React.ReactNode }) {
    const mode = useAppMode();
    const palette = useLocalSetting('palette');
    const textSize = useLocalSetting('uiSize');
    const name = themeName(mode, palette);
    return (
        <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
            <TextSizeContext.Provider value={textSize}>
                <Theme name={name}>{children}</Theme>
            </TextSizeContext.Provider>
        </TamaguiProvider>
    );
}
