/**
 * Shared scale, typography, layout, and fixed non-chrome inks for Beeline.
 * Consumed by Tamagui on mobile/web/desktop and emitted into CSS for apps/site.
 */

export const BRAND_MARK = '#E5A645';

const ROOM_LIST_EDGE = 20;
// The Room list edge icons share one centre line: the centre of the search
// mark when its ink ends on the edge. Search is the widest mark, so no ink
// crosses the edge. Its 21-point Ionicons search-outline glyph inks 44 to 466
// of its 512-unit advance.
const SEARCH_SIZE = 21;
const SEARCH_INK_START = 44;
const SEARCH_INK_END = 466;
const ROOM_LIST_ICON_CENTRE =
  ROOM_LIST_EDGE + (SEARCH_SIZE * (SEARCH_INK_END - SEARCH_INK_START)) / 512 / 2;
// The tray and + inks are centred in their boxes, so a box's end padding is
// the centre line less half the box.
const roomListIconEnd = (box: number) => ROOM_LIST_ICON_CENTRE - box / 2;

export const radii = {
  house: 3,
  code: 8,
  transcript: 10,
  viewer: 14,
  roomCard: 14,
} as const;

export const shared = {
  // Dimensions and type from the owner-approved Trusty Squire mock v3.
  squireConnect: {
    sectionType: { fontFamily: 'SpaceGrotesk-Medium', fontSize: 12, lineHeight: 22, letterSpacing: 2 },
    titleType: { fontFamily: 'SpaceGrotesk-Medium', fontSize: 18, lineHeight: 26 },
    detailType: { fontFamily: 'SpaceGrotesk-Regular', fontSize: 14, lineHeight: 21 },
    contentGap: 10, dotGap: 6, progressBottom: 28, stepBottom: 26, copyTop: 2,
    centerSide: 40, centerBottom: 64, bareBottom: 152, railRadius: 1, barRadius: 2,
  },
  brandMark: BRAND_MARK,
  // The one box radius, shared by every theme (docs/DESIGN.md -> Shapes).
  radius: radii.house,
  // The one floating-surface shadow ink; its density is per theme (`dialogShadowOpacity`).
  dialogShadowColor: '#000000',
  // Explicit black selection frame for conversation routing.
  voiceSelectionFrame: '#000000',
  transcriptCard: {
    cornerRadius: radii.transcript,
    marginTop: 8,
    marginBottom: 8,
    headTop: 16,
    side: 16,
    identitySize: 26,
    bodySize: 16,
    bodyLineHeight: 23,
    rowStateWidth: 92,
    rowVertical: 8,
    codeTop: 8,
    codeVertical: 8,
    codeHorizontal: 16,
    codeRadius: radii.code,
    codePathSize: 13,
    rowTitleSize: 16,
    rowKindSize: 13,
    footerTop: 16,
    footerVertical: 8,
    footerMinHeight: 44,
  },
  // Mobile Room list cards (approved Room list card mock). Desktop rows keep
  // the body/meta roles.
  roomCard: {
    cornerRadius: radii.roomCard,
    gap: 8,
  },
  // One Room list edge on phone and desktop (approved Room list margins mock).
  roomList: {
    edge: ROOM_LIST_EDGE,
    trayEnd: roomListIconEnd(44),
    addEnd: roomListIconEnd(44),
    searchEnd: ROOM_LIST_EDGE - (44 - SEARCH_SIZE) / 2 - (SEARCH_SIZE * (512 - SEARCH_INK_END)) / 512,
    compactAddEnd: roomListIconEnd(24),
    dotEnd: ROOM_LIST_EDGE - 3,
    selectedStart: ROOM_LIST_EDGE - 1,
  },
  agentProfileTypography: { name: { fontSize: 28, lineHeight: 36 } },
} as const;

const calmLineHeight = (fontSize: number) => Math.round(fontSize * 1.45);
const sans = {
  regular: 'SpaceGrotesk-Regular',
  medium: 'SpaceGrotesk-Medium',
  semiBold: 'SpaceGrotesk-SemiBold',
} as const;
const mono = 'IBMPlexMono-Regular';

export type TypeRole = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly textTransform?: 'uppercase';
};

export const typeRoles = {
  /** A screen's one big line, including index row names. */
  hero: {
    fontFamily: sans.medium,
    fontSize: 22,
    lineHeight: calmLineHeight(22),
    letterSpacing: -0.3,
  },
  /** Body text and row titles. */
  body: {
    fontFamily: sans.regular,
    fontSize: 16,
    lineHeight: calmLineHeight(16),
    letterSpacing: 0,
  },
  bodyStrong: {
    fontFamily: sans.semiBold,
    fontSize: 16,
    lineHeight: calmLineHeight(16),
    letterSpacing: 0,
  },
  /** Everything secondary: previews, captions, stamps, counts. Sans, never mono. */
  meta: {
    fontFamily: sans.regular,
    fontSize: 13,
    lineHeight: calmLineHeight(13),
    letterSpacing: 0,
  },
  /** Section heads ONLY — the one tracked-uppercase style. */
  sectionHead: {
    fontFamily: sans.medium,
    fontSize: 10,
    lineHeight: calmLineHeight(10),
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  /** Shared section header label and count, aligned on one line. */
  sectionLabel: {
    fontFamily: sans.medium,
    fontSize: 12,
    lineHeight: calmLineHeight(12),
    letterSpacing: 2,
  },
  sectionCount: {
    fontFamily: sans.regular,
    fontSize: 15,
    lineHeight: calmLineHeight(15),
    letterSpacing: 0,
  },
  /** Literal machine output: commands, paths, hashes, code, tool rows, their timestamps. */
  machine: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: calmLineHeight(13),
    letterSpacing: 0,
  },
} as const satisfies Record<string, TypeRole>;

/** The one spacing scale. Nothing is nudged by 3. */
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

/** Rows are 64 tall, sections sit 24 apart, screens start 24 below the header. */
export const layout = { row: 64, sectionGap: 24, screenTop: 24 } as const;

/** The one scrim behind every sheet. */
export const SCRIM = 'rgba(0,0,0,0.8)';

/** Android notification channel light (ARGB). */
export const NOTIFICATION_LIGHT = '#FF231F7C';

/**
 * Identity art (the face tiles): fixed inks that are the identity, not chrome,
 * so they do not follow the theme. `bone`/`ink` draw the creature;
 * `plateDark`/`plateLight` are the person plate per mode.
 */
export const IDENTITY_ART = {
  bone: '#F2E9D8',
  ink: '#14091A',
  plateDark: '#0f0a13',
  plateLight: '#F5EEE2',
} as const;

/** Paper and ink that scanners read in every theme (wallet QR, embedded documents). */
export const QR_PAPER = '#ffffff';
export const QR_INK = '#171310';

export const proseTypography = {
  proseRegular: 'SpaceGrotesk-Regular',
  proseMedium: 'SpaceGrotesk-Medium',
  proseSemibold: 'SpaceGrotesk-SemiBold',
  monoRegular: 'IBMPlexMono-Regular',
  monoItalic: 'IBMPlexMono-Italic',
  monoSemibold: 'IBMPlexMono-SemiBold',
  proseSize: 16,
  proseLineHeight: 23,
  leadSize: 16,
  leadLineHeight: 23,
  messageGap: 0,
  messagePaddingVertical: 6,
  railWidth: 2,
  railInset: 12,
} as const;
