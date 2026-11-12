import { useSyncExternalStore } from 'react';
import { Appearance, Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { applySystemBackground } from './buzz/system-background';
import { captureMobileError } from './buzz/sentry-entry';
import { setAndroidNavigationBarStyle } from './buzz/android-navigation-bar';
import type { LocalSettings } from './sync/localSettings';
import { loadLocalSettings } from './sync/persistence';
import {
    applyEffectiveAndroidLaunchAppearance,
    pinAndroidLaunchAppearance,
} from './buzz/android-launch-appearance';
import { resolveAppAppearance, seedAppAppearanceFromSystem } from './buzz/app-appearance-seed';
import { beelineThemes } from './buzz/groknight';

/**
 * Light or dark for the whole app. Settings → Appearance writes it; the grammar
 * (GrammarProvider) reads it. The native root and system bars follow the canvas.
 */
export type AppMode = 'light' | 'dark';

// Complete the one-time migration before any settings consumers mount.
seedAppAppearanceFromSystem();
let appearance: LocalSettings['appearance'] = loadLocalSettings().appearance;
let mode: AppMode = resolveAppAppearance(appearance);
const listeners = new Set<() => void>();

/** Obsidian (dark) needs light navigation buttons; bone (light) needs dark ones. */
export function navigationBarStyleForMode(next: AppMode): 'light' | 'dark' {
    return next === 'dark' ? 'dark' : 'light';
}

function applyRootBackground(next: AppMode): void {
    const rootColor = beelineThemes[next === 'dark' ? 'obsidian' : 'bone'].bgBase;
    void applySystemBackground(() => SystemUI.setBackgroundColorAsync(rootColor),
        error => captureMobileError('system-background', error));
    if (Platform.OS === 'android') {
        void setAndroidNavigationBarStyle(navigationBarStyleForMode(next));
    }
}

applyRootBackground(mode);

/** Switch the live mode and carry the native root and system chrome with it. */
export function setAppDisplay(next: LocalSettings['appearance']): void {
    appearance = next;
    const resolved = resolveAppAppearance(next);
    if (resolved === mode) return;
    mode = resolved;
    applyRootBackground(mode);
    for (const listener of listeners) listener();
}

/** Settings → Appearance: also pins the Android launch screen to the choice. */
export function applyAppearanceChoice(next: LocalSettings['appearance']): void {
    setAppDisplay(next);
    pinAndroidLaunchAppearance(next);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getAppMode(): AppMode {
    return mode;
}

export function useAppMode(): AppMode {
    return useSyncExternalStore(subscribe, getAppMode, getAppMode);
}

// The OS remains the authority only while System is selected.
Appearance.addChangeListener(() => {
    if (appearance === 'system') setAppDisplay('system');
});

// Subscribe before clearing a native override: that reset can emit a change.
applyEffectiveAndroidLaunchAppearance();
