import { createTamagui } from 'tamagui';
import { defaultConfig } from '@tamagui/config/v6';
import { installWebControlProps } from './web-control-props';
// `animations` is the driver both platforms export: CSS on web, React Native
// animations on phones. `animationsCSS` exists only on web, so on phones every
// Sheet threw Tamagui error 008 (no animation driver).
import { animations } from '@tamagui/config/animations-css';
import { beelineThemes, stonePalette as STONE, type BeelineThemeTokens } from '@/buzz/groknight';

/**
 * The one design grammar's colour layer (build spec → The grammar). Ten
 * semantic tokens per theme — canvas, raised, highlight, stroke, strongStroke,
 * ink, secondary, needsYou (brass), added, removed — plus the button fills.
 * Values come from the Beeline token set (`groknight.ts`); the Stone colour
 * set swaps the neutral ladder and keeps every component.
 */
export type Palette = 'brass' | 'stone';
export type Mode = 'dark' | 'light';


function themeValues(mode: Mode, palette: Palette): Record<string, string> & { needsYou: string; primaryInk: string; primaryFill: string; raised: string } {
    const base = beelineThemes[mode === 'dark' ? 'obsidian' : 'bone'];
    const c = (palette === 'brass' ? base : { ...base, ...STONE[mode] }) as BeelineThemeTokens;
    const theme = {
        ...(defaultConfig.themes[mode] as Record<string, string>),
        'color-1': c.bgBase, 'color-2': c.bgRaised, 'color-3': c.bgHighlight, 'color-4': c.border,
        'color-5': c.borderStrong, 'color-6': c.textMuted, 'color-7': c.textMuted, 'color-8': c.textSecondary,
        'color-9': c.textSecondary, 'color-10': c.textPrimary, 'color-11': c.textPrimary,
        background: c.bgBase, 'background-hover': c.bgHighlight, 'background-press': c.bgHighlight,
        'background-focus': c.bgHighlight, 'background-active': c.bgHighlight,
        color: c.textPrimary, 'color-hover': c.textPrimary, 'color-press': c.textPrimary, 'color-focus': c.textPrimary,
        'border-color': c.border, 'border-color-hover': c.borderStrong, 'border-color-press': c.borderStrong,
        'border-color-focus': c.borderStrong, 'placeholder-color': c.textMuted, 'outline-color': c.textSecondary,
        'accent-background': c.accent, 'accent-color': c.buttonPrimaryText,
        canvas: c.bgBase, raised: c.bgRaised, highlight: c.bgHighlight,
        stroke: c.border, strongStroke: c.borderStrong,
        ink: c.textPrimary, secondary: c.textSecondary,
        needsYou: c.accent, added: c.diffAdded, removed: c.diffRemoved,
        primaryFill: c.buttonPrimaryFill, primaryInk: c.buttonPrimaryText,
        // The tab bar's selected and other tabs. Stone's accent is its
        // secondary ink, so there the selected tab is primary ink and the
        // others are muted.
        tabOn: palette === 'stone' ? c.textPrimary : c.accent,
        tabOff: palette === 'stone' ? c.textMuted : c.textSecondary,
    };
    return theme;
}

const themes: Record<string, Record<string, string>> = {};
for (const mode of ['dark', 'light'] as const) {
    for (const palette of ['brass', 'stone'] as const) {
        const base = themeValues(mode, palette);
        const name = `${mode}_${palette}`;
        themes[name] = base;
        // Brass fill (count pills, the one selected choice).
        themes[`${name}_brand`] = {
            ...base, background: base.needsYou, color: base.primaryInk,
            'background-hover': base.needsYou, 'background-press': base.needsYou,
            'color-hover': base.primaryInk, 'color-press': base.primaryInk, 'border-color': base.needsYou,
        };
        // The one primary action per view.
        themes[`${name}_button`] = {
            ...base, background: base.primaryFill, color: base.primaryInk,
            'background-hover': base.primaryFill, 'background-press': base.primaryFill,
            'color-hover': base.primaryInk, 'color-press': base.primaryInk,
        };
        themes[`${name}_surface`] = { ...base, background: base.raised };
    }
}

export const themeName = (mode: Mode, palette: Palette) => `${mode}_${palette}`;

// Six type styles use three faces and two sizes (13 and 16) plus the title (22).
const body = {
    ...defaultConfig.fonts.body,
    family: 'SpaceGrotesk-Regular',
    size: { ...defaultConfig.fonts.body.size, sm: 13, base: 16, '2xl': 22 },
    lineHeight: { ...defaultConfig.fonts.body.lineHeight, sm: 19, base: 23, '2xl': 32 },
    face: { 400: { normal: 'SpaceGrotesk-Regular' }, 600: { normal: 'SpaceGrotesk-SemiBold' } },
};

export const tamaguiConfig = createTamagui({
    ...defaultConfig,
    // Historical browser surfaces retain their pre-redesign geometry.
    tokens: { ...defaultConfig.tokens, radius: { ...defaultConfig.tokens.radius, transcript: 10, viewer: 14 } },
    animations,
    // Longhand style props (paddingHorizontal, backgroundColor) are the grammar's spelling.
    settings: { ...defaultConfig.settings, onlyAllowShorthands: false },
    themes,
    fonts: { ...defaultConfig.fonts, body, heading: body, mono: { ...body, family: 'IBMPlexMono-Regular' } },
});

export type AppTamaguiConfig = typeof tamaguiConfig;

// Web host: accessibilityRole and accessibilityLabel become role and aria-label.
installWebControlProps();

declare module 'tamagui' {
    interface TamaguiCustomConfig extends AppTamaguiConfig {}
}
