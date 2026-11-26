import { stone } from './palettes.js';
import { radii, SCRIM, space } from './scale.js';

const STONE_CYPHER = {
  dark: {
    hi: '#a8a29e',
    mid: '#78716c',
    low: '#44403c',
    void: '#1c1917',
  },
  light: {
    hi: '#57534e',
    mid: '#78716c',
    low: '#d6d3d1',
    void: '#f5f5f4',
  },
} as const;

/**
 * Emit the canonical Stone CSS custom properties for standalone pages under
 * `apps/site/` and server-rendered HTML. Dark Stone is the default; light
 * Stone activates automatically under `prefers-color-scheme: light`.
 */
export function generateStoneCss(): string {
  const dark = stone.dark;
  const light = stone.light;

  return `/* Generated from @beeline/design-tokens. Do not edit by hand. Run: npm run tokens:css */
:root {
  color-scheme: dark light;
  --canvas: ${dark.bgBase};
  --raised: ${dark.bgRaised};
  --highlight: ${dark.bgHighlight};
  --unread: ${dark.bgUnread};
  --border: ${dark.border};
  --stroke: ${dark.border};
  --strong: ${dark.borderStrong};
  --ink: ${dark.textPrimary};
  --secondary: ${dark.textSecondary};
  --muted: ${dark.textMuted};
  --quiet: ${dark.ledgerQuiet};
  --accent: ${dark.accent};
  --needs-you: ${dark.accent};
  --primary-fill: ${dark.buttonPrimaryFill};
  --primary-ink: ${dark.buttonPrimaryText};
  --added: ${dark.diffAdded};
  --removed: ${dark.diffRemoved};
  --scrim: ${SCRIM};
  --cypher-hi: ${STONE_CYPHER.dark.hi};
  --cypher-mid: ${STONE_CYPHER.dark.mid};
  --cypher-low: ${STONE_CYPHER.dark.low};
  --cypher-void: ${STONE_CYPHER.dark.void};
  --radius-house: ${radii.house}px;
  --radius-code: ${radii.code}px;
  --radius-transcript: ${radii.transcript}px;
  --radius-room-card: ${radii.roomCard}px;
  --space-xs: ${space.xs}px;
  --space-sm: ${space.sm}px;
  --space-md: ${space.md}px;
  --space-lg: ${space.lg}px;
  --space-xl: ${space.xl}px;
  --space-xxl: ${space.xxl}px;
  --font-sans: 'Space Grotesk', system-ui, -apple-system, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --canvas: ${light.bgBase};
    --raised: ${light.bgRaised};
    --highlight: ${light.bgHighlight};
    --unread: ${light.bgUnread};
    --border: ${light.border};
    --stroke: ${light.border};
    --strong: ${light.borderStrong};
    --ink: ${light.textPrimary};
    --secondary: ${light.textSecondary};
    --muted: ${light.textMuted};
    --quiet: ${light.ledgerQuiet};
    --accent: ${light.accent};
    --needs-you: ${light.accent};
    --primary-fill: ${light.buttonPrimaryFill};
    --primary-ink: ${light.buttonPrimaryText};
    --added: ${light.diffAdded};
    --removed: ${light.diffRemoved};
    --cypher-hi: ${STONE_CYPHER.light.hi};
    --cypher-mid: ${STONE_CYPHER.light.mid};
    --cypher-low: ${STONE_CYPHER.light.low};
    --cypher-void: ${STONE_CYPHER.light.void};
  }
}
`;
}
