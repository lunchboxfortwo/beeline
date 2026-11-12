import React from 'react';
import { TamaguiProvider, Theme } from 'tamagui';
import { useAppMode } from '@/display';
import { useLocalSetting } from '@/sync/storage';
import { APP_UI_SIZE_SCALE } from '@/ui-size';
import { TextScaleContext } from './grammar';
import { tamaguiConfig, themeName } from './tamagui.config';

/**
 * Mounts the grammar's theme (Obsidian or Bone from Appearance, Brass or Stone
 * from Color set) and its text scale (Settings → You → Text size).
 */
export function GrammarProvider({ children }: { children: React.ReactNode }) {
    const mode = useAppMode();
    const palette = useLocalSetting('palette');
    const scale = APP_UI_SIZE_SCALE[useLocalSetting('uiSize')];
    const name = themeName(mode, palette);
    return (
        <TamaguiProvider config={tamaguiConfig} defaultTheme={name}>
            <TextScaleContext.Provider value={scale}>
                <Theme name={name}>{children}</Theme>
            </TextScaleContext.Provider>
        </TamaguiProvider>
    );
}
