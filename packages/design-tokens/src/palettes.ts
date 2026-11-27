import { layout, proseTypography, shared, space, typeRoles } from './scale.js';

/**
 * Complete peer palettes for Beeline: Stone (default neutral palette) and
 * Brass (Obsidian dark + Bone light). Every theme defines the full semantic
 * token surface so Stone never inherits Obsidian purple or Bone cream values.
 */

export type Palette = 'brass' | 'stone';
export type Mode = 'dark' | 'light';

type ThemeColorFields = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly dark: boolean;
  readonly bgVoid: string;
  readonly bgTerminal: string;
  readonly bgBase: string;
  readonly bgRaised: string;
  readonly bgCode: string;
  readonly bgHighlight: string;
  readonly bgUnread: string;
  readonly bgHover: string;
  readonly bgPressed: string;
  readonly bgTexturePeak: string;
  readonly bgVisual: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly textDisabled: string;
  readonly textInverted: string;
  readonly actionFill: string;
  readonly buttonPrimaryFill: string;
  readonly buttonPrimaryText: string;
  readonly buttonProviderFill: string;
  readonly buttonProviderText: string;
  readonly buttonSecondaryText: string;
  readonly appCanvas: string;
  readonly appTile: string;
  readonly appCard: string;
  readonly appInk: string;
  readonly appSecondary: string;
  readonly appQuiet: string;
  readonly appBorder: string;
  readonly appStrongBorder: string;
  readonly appCardBorder: string;
  readonly chrome: string;
  readonly steel: string;
  readonly signalBright: string;
  readonly signalMid: string;
  readonly signalDim: string;
  readonly danger: string;
  readonly dialogDanger: string;
  readonly success: string;
  readonly warning: string;
  readonly accent: string;
  readonly humanRail: string;
  readonly agentRail: string;
  readonly diffAdded: string;
  readonly diffRemoved: string;
  readonly syntaxStructure: string;
  readonly syntaxName: string;
  readonly syntaxValue: string;
  readonly ledgerBright: string;
  readonly ledgerBody: string;
  readonly ledgerQuiet: string;
  readonly ledgerGhost: string;
  readonly ledgerGlow: string;
  readonly avatarGround: string;
  readonly avatarInk: string;
  readonly avatarSoft: string;
  readonly avatarDim: string;
  readonly agentAccent: string;
  readonly borderQuiet: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly focus: string;
  readonly selectedBorder: string;
  readonly selection: string;
  readonly muted: string;
  readonly dim: string;
  readonly gutter: string;
  readonly faint: string;
  readonly tertiary: string;
  readonly borderActive: string;
  readonly brassWash: string;
  readonly brassWashStrong: string;
  readonly dialogShadowOpacity: number;
  readonly codeError: string;
};

export type BeelineThemeTokens = typeof shared &
  typeof proseTypography & {
    readonly type: typeof typeRoles;
    readonly space: typeof space;
    readonly layout: typeof layout;
  } & ThemeColorFields;

function defineTheme<const T extends ThemeColorFields>(fields: T): BeelineThemeTokens & T {
  return {
    ...shared,
    ...proseTypography,
    type: typeRoles,
    space,
    layout,
    ...fields,
  };
}

/**
 * Stone: Beeline's neutral default palette (Stone Dark + Stone Light).
 * Complete peer token sets with clean neutral greys across every surface,
 * border, and text tier.
 */
export const stone = {
  dark: defineTheme({
    name: 'stone-dark',
    label: 'Stone Dark',
    description: 'Readable sans prose on a neutral stone dark field',
    dark: true,
    bgVoid: '#171717',
    bgTerminal: '#171717',
    bgBase: '#171717',
    bgRaised: '#222222',
    bgCode: '#222222',
    bgHighlight: '#2c2c2c',
    bgUnread: '#242424',
    bgHover: '#292929',
    bgPressed: '#303030',
    bgTexturePeak: '#44403c',
    bgVisual: '#222222',
    textPrimary: '#fafaf9',
    textSecondary: '#d6d3d1',
    textMuted: '#a8a29e',
    textDisabled: '#78716c',
    textInverted: '#1c1917',
    actionFill: '#fafaf9',
    buttonPrimaryFill: '#f5f5f4',
    buttonPrimaryText: '#1c1917',
    buttonProviderFill: '#FFFFFF',
    buttonProviderText: '#1c1917',
    buttonSecondaryText: '#f5f5f4',
    appCanvas: '#171717',
    appTile: '#222222',
    appCard: '#222222',
    appInk: '#fafaf9',
    appSecondary: '#d6d3d1',
    appQuiet: '#a8a29e',
    appBorder: '#353535',
    appStrongBorder: '#57534e',
    appCardBorder: '#57534e',
    chrome: '#a8a29e',
    steel: '#a8a29e',
    signalBright: '#d6d3d1',
    signalMid: '#a8a29e',
    signalDim: '#78716c',
    danger: '#fafaf9',
    dialogDanger: '#c4544d',
    success: '#fafaf9',
    warning: '#d6d3d1',
    accent: '#d6d3d1',
    humanRail: '#d6d3d1',
    agentRail: '#57534e',
    diffAdded: '#3FB950',
    diffRemoved: '#F85149',
    syntaxStructure: '#78716c',
    syntaxName: '#c4b5d6',
    syntaxValue: '#a8cde8',
    ledgerBright: '#fafaf9',
    ledgerBody: '#d6d3d1',
    ledgerQuiet: '#a8a29e',
    ledgerGhost: '#78716c',
    ledgerGlow: 'transparent',
    avatarGround: '#171717',
    avatarInk: '#fafaf9',
    avatarSoft: '#a8a29e',
    avatarDim: '#57534e',
    agentAccent: '#d6d3d1',
    borderQuiet: '#353535',
    border: '#353535',
    borderStrong: '#57534e',
    focus: '#a8a29e',
    selectedBorder: '#a8a29e',
    selection: '#2c2c2c',
    muted: '#a8a29e',
    dim: '#a8a29e',
    gutter: '#78716c',
    faint: '#57534e',
    tertiary: '#78716c',
    borderActive: '#a8a29e',
    brassWash: 'rgba(214,211,209,0.16)',
    brassWashStrong: 'rgba(214,211,209,0.26)',
    dialogShadowOpacity: 0.55,
    codeError: '#c98a8a',
  }),
  light: defineTheme({
    name: 'stone-light',
    label: 'Stone Light',
    description: 'Readable sans prose on a neutral stone light field',
    dark: false,
    bgVoid: '#fafaf9',
    bgTerminal: '#fafaf9',
    bgBase: '#fafaf9',
    bgRaised: '#f5f5f4',
    bgCode: '#f5f5f4',
    bgHighlight: '#e7e5e4',
    bgUnread: '#f0efed',
    bgHover: '#eceae8',
    bgPressed: '#e2e0de',
    bgTexturePeak: '#d6d3d1',
    bgVisual: '#f5f5f4',
    textPrimary: '#1c1917',
    textSecondary: '#44403c',
    textMuted: '#6b6560',
    textDisabled: '#a8a29e',
    textInverted: '#fafaf9',
    actionFill: '#1c1917',
    buttonPrimaryFill: '#1c1917',
    buttonPrimaryText: '#fafaf9',
    buttonProviderFill: '#FFFFFF',
    buttonProviderText: '#1c1917',
    buttonSecondaryText: '#1c1917',
    appCanvas: '#fafaf9',
    appTile: '#f5f5f4',
    appCard: '#f5f5f4',
    appInk: '#1c1917',
    appSecondary: '#44403c',
    appQuiet: '#6b6560',
    appBorder: '#e7e5e4',
    appStrongBorder: '#d6d3d1',
    appCardBorder: '#d6d3d1',
    chrome: '#6b6560',
    steel: '#6b6560',
    signalBright: '#44403c',
    signalMid: '#6b6560',
    signalDim: '#a8a29e',
    danger: '#1c1917',
    dialogDanger: '#c4544d',
    success: '#1c1917',
    warning: '#57534e',
    accent: '#57534e',
    humanRail: '#57534e',
    agentRail: '#d6d3d1',
    diffAdded: '#1a7f37',
    diffRemoved: '#cf222e',
    syntaxStructure: '#6b6560',
    syntaxName: '#6b5a83',
    syntaxValue: '#1e4460',
    ledgerBright: '#1c1917',
    ledgerBody: '#44403c',
    ledgerQuiet: '#6b6560',
    ledgerGhost: '#a8a29e',
    ledgerGlow: 'transparent',
    avatarGround: '#fafaf9',
    avatarInk: '#1c1917',
    avatarSoft: '#6b6560',
    avatarDim: '#d6d3d1',
    agentAccent: '#57534e',
    borderQuiet: '#e7e5e4',
    border: '#e7e5e4',
    borderStrong: '#d6d3d1',
    focus: '#6b6560',
    selectedBorder: '#6b6560',
    selection: '#e7e5e4',
    muted: '#6b6560',
    dim: '#6b6560',
    gutter: '#a8a29e',
    faint: '#d6d3d1',
    tertiary: '#a8a29e',
    borderActive: '#6b6560',
    brassWash: 'rgba(87,83,78,0.14)',
    brassWashStrong: 'rgba(87,83,78,0.22)',
    dialogShadowOpacity: 0.14,
    codeError: '#a8524f',
  }),
} as const;

/**
 * Brass: Obsidian dark and Bone light peer palette (Settings -> Device -> Color set).
 */
export const brass = {
  obsidian: defineTheme({
    name: 'obsidian',
    label: 'Obsidian Refined',
    description: 'Readable sans prose on a quiet obsidian field',
    dark: true,
    bgVoid: '#14091A',
    bgTerminal: '#14091A',
    bgBase: '#14091A',
    bgRaised: '#190e21',
    bgCode: '#190e21',
    bgHighlight: '#1e1326',
    bgUnread: '#1a1220',
    bgHover: '#21162a',
    bgPressed: '#271c31',
    bgTexturePeak: '#3b3048',
    bgVisual: '#190e21',
    textPrimary: '#f0f0f3',
    textSecondary: '#c9c9d1',
    textMuted: '#83838d',
    textDisabled: '#6c6c76',
    textInverted: '#111111',
    actionFill: '#f0f0f3',
    buttonPrimaryFill: '#F3EDE3',
    buttonPrimaryText: '#1C1712',
    buttonProviderFill: '#FFFFFF',
    buttonProviderText: '#171310',
    buttonSecondaryText: '#F3EDE3',
    appCanvas: '#14091A',
    appTile: '#190e21',
    appCard: '#190e21',
    appInk: '#f0f0f3',
    appSecondary: '#c9c9d1',
    appQuiet: '#90909B',
    appBorder: '#291e33',
    appStrongBorder: '#3b3048',
    appCardBorder: '#3b3048',
    chrome: '#83838d',
    steel: '#83838d',
    signalBright: '#c9c9d1',
    signalMid: '#83838d',
    signalDim: '#6c6c76',
    danger: '#f0f0f3',
    dialogDanger: '#c4544d',
    success: '#f0f0f3',
    warning: '#b08a4a',
    accent: '#b08a4a',
    humanRail: '#b08a4a',
    agentRail: '#3b3048',
    diffAdded: '#3FB950',
    diffRemoved: '#F85149',
    syntaxStructure: '#6c6c76',
    syntaxName: '#a58ec6',
    syntaxValue: '#a8cde8',
    ledgerBright: '#f0f0f3',
    ledgerBody: '#c9c9d1',
    ledgerQuiet: '#90909B',
    ledgerGhost: '#6c6c76',
    ledgerGlow: 'transparent',
    avatarGround: '#14091A',
    avatarInk: '#f0f0f3',
    avatarSoft: '#83838d',
    avatarDim: '#3b3048',
    agentAccent: '#b08a4a',
    borderQuiet: '#291e33',
    border: '#291e33',
    borderStrong: '#3b3048',
    focus: '#83838d',
    selectedBorder: '#83838d',
    selection: '#1e1326',
    muted: '#83838d',
    dim: '#83838d',
    gutter: '#6c6c76',
    faint: '#3b3048',
    tertiary: '#6c6c76',
    borderActive: '#83838d',
    brassWash: 'rgba(176,138,74,0.18)',
    brassWashStrong: 'rgba(176,138,74,0.28)',
    dialogShadowOpacity: 0.55,
    codeError: '#c98a8a',
  }),
  bone: defineTheme({
    name: 'bone',
    label: 'Bone',
    description: 'Readable sans prose on a quiet bone field',
    dark: false,
    bgVoid: '#F3EEE4',
    bgTerminal: '#F3EEE4',
    bgBase: '#F3EEE4',
    bgRaised: '#ECE4D5',
    bgCode: '#ECE4D5',
    bgHighlight: '#E4D9C4',
    bgUnread: '#EFE8DA',
    bgHover: '#E2D7C2',
    bgPressed: '#E0D5BE',
    bgTexturePeak: '#C9BBA0',
    bgVisual: '#ECE4D5',
    textPrimary: '#171310',
    textSecondary: '#4A4038',
    textMuted: '#8B7F6E',
    textDisabled: '#A79C89',
    textInverted: '#FBF8F2',
    actionFill: '#171310',
    buttonPrimaryFill: '#1C1712',
    buttonPrimaryText: '#F3EDE3',
    buttonProviderFill: '#FFFFFF',
    buttonProviderText: '#171310',
    buttonSecondaryText: '#1C1712',
    appCanvas: '#F3EDE3',
    appTile: '#FBF8F2',
    appCard: '#F8F3EA',
    appInk: '#1C1712',
    appSecondary: '#3A332B',
    appQuiet: '#6F6558',
    appBorder: '#E2D9CB',
    appStrongBorder: '#B8A27A',
    appCardBorder: '#D8CCB8',
    chrome: '#8B7F6E',
    steel: '#8B7F6E',
    signalBright: '#4A4038',
    signalMid: '#8B7F6E',
    signalDim: '#A79C89',
    danger: '#171310',
    dialogDanger: '#c4544d',
    success: '#171310',
    warning: '#8a6323',
    accent: '#8a6323',
    humanRail: '#8a6323',
    agentRail: '#C9BBA0',
    diffAdded: '#1a7f37',
    diffRemoved: '#cf222e',
    syntaxStructure: '#8B7F6E',
    syntaxName: '#6b5a83',
    syntaxValue: '#1e4460',
    ledgerBright: '#171310',
    ledgerBody: '#4A4038',
    ledgerQuiet: '#6F6455',
    ledgerGhost: '#A79C89',
    ledgerGlow: 'transparent',
    avatarGround: '#F3EEE4',
    avatarInk: '#171310',
    avatarSoft: '#8B7F6E',
    avatarDim: '#C9BBA0',
    agentAccent: '#8a6323',
    borderQuiet: '#DED2BC',
    border: '#DED2BC',
    borderStrong: '#C9BBA0',
    focus: '#8B7F6E',
    selectedBorder: '#8B7F6E',
    selection: '#E4D9C4',
    muted: '#8B7F6E',
    dim: '#8B7F6E',
    gutter: '#A79C89',
    faint: '#C9BBA0',
    tertiary: '#A79C89',
    borderActive: '#8B7F6E',
    brassWash: 'rgba(138,99,35,0.18)',
    brassWashStrong: 'rgba(138,99,35,0.28)',
    dialogShadowOpacity: 0.14,
    codeError: '#a8524f',
  }),
} as const;

export const beelineThemes = brass;
export const stonePalette = stone;

/** Resolve the complete theme tokens for a mode and colour set. */
export function resolveTheme(mode: Mode, palette: Palette): BeelineThemeTokens {
  return palette === 'stone' ? stone[mode] : brass[mode === 'dark' ? 'obsidian' : 'bone'];
}

/**
 * The window canvas under the grammar's theme, for the layers mounted above it
 * (native root, system bars, navigation container, web body).
 */
export function canvasColor(mode: Mode, palette: Palette): string {
  return resolveTheme(mode, palette).bgBase;
}
