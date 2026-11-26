import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  beelineThemes,
  BRAND_MARK,
  brass,
  canvasColor,
  generateStoneCss,
  radii,
  resolveTheme,
  space,
  stone,
  stonePalette,
  typeRoles,
  type BeelineThemeTokens,
} from './index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Expected 6-digit hex colour, got ${hex}`);
  const channels = [match[1]!, match[2]!, match[3]!].map((part) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

type FrontmatterMap = Record<string, string | Record<string, string | Record<string, string>>>;

function parseDesignFrontmatter(markdown: string): FrontmatterMap {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error('docs/DESIGN.md is missing YAML frontmatter');
  const root: FrontmatterMap = {};
  let section: string | null = null;
  let subsection: string | null = null;
  const unquote = (raw: string) => raw.trim().replace(/^"(.*)"$/, '$1');

  for (const rawLine of match[1]!.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const key = rawLine.slice(0, colon).trim();
    const rest = rawLine.slice(colon + 1).trim();

    if (indent === 0) {
      section = key;
      subsection = null;
      root[key] = rest ? unquote(rest) : {};
    } else if (indent === 2 && section) {
      const parent = root[section] as Record<string, string | Record<string, string>>;
      if (rest) {
        parent[key] = unquote(rest);
        subsection = null;
      } else {
        parent[key] = {};
        subsection = key;
      }
    } else if (indent === 4 && section && subsection) {
      const parent = (root[section] as Record<string, Record<string, string>>)[subsection]!;
      parent[key] = unquote(rest);
    }
  }
  return root;
}

describe('@beeline/design-tokens', () => {
  it.each([
    ['light', 'brass', beelineThemes.bone.bgBase],
    ['dark', 'brass', beelineThemes.obsidian.bgBase],
    ['light', 'stone', stonePalette.light.bgBase],
    ['dark', 'stone', stonePalette.dark.bgBase],
  ] as const)(
    "Reproduction STONE-1: the window canvas in %s %s is the colour set's own canvas",
    (mode, palette, expected) => {
      expect(canvasColor(mode, palette)).toBe(expected);
      expect(resolveTheme(mode, palette).bgBase).toBe(expected);
    },
  );

  it('defines Stone and Brass as complete peer palettes with zero Obsidian/Bone leaks in Stone', () => {
    const obsidianKeys = Object.keys(brass.obsidian).sort();
    expect(Object.keys(brass.bone).sort()).toEqual(obsidianKeys);
    expect(Object.keys(stone.dark).sort()).toEqual(obsidianKeys);
    expect(Object.keys(stone.light).sort()).toEqual(obsidianKeys);

    const leakedObsidianOrBone = new Set([
      '#14091a',
      '#190e21',
      '#1e1326',
      '#1a1220',
      '#21162a',
      '#271c31',
      '#291e33',
      '#3b3048',
      '#f3eee4',
      '#ece4d5',
      '#e4d9c4',
      '#efe8da',
      '#ded2bc',
      '#c9bba0',
      '#b08a4a',
      '#8a6323',
    ]);
    for (const [themeName, theme] of [
      ['stone.dark', stone.dark],
      ['stone.light', stone.light],
    ] as const) {
      for (const [key, value] of Object.entries(theme)) {
        if (typeof value !== 'string') continue;
        expect(
          leakedObsidianOrBone.has(value.toLowerCase()),
          `${themeName}.${key} leaked Brass palette value ${value}`,
        ).toBe(false);
      }
    }
  });

  it.each([
    ['stone.dark', stone.dark],
    ['stone.light', stone.light],
    ['brass.obsidian', brass.obsidian],
    ['brass.bone', brass.bone],
  ] as const)(
    'holds WCAG AA contrast (>= 4.5:1) for readable text and primary actions in %s',
    (_label, theme: BeelineThemeTokens) => {
      for (const ground of [theme.bgBase, theme.bgRaised, theme.bgUnread]) {
        expect(contrastRatio(theme.textPrimary, ground)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.textSecondary, ground)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.ledgerQuiet, ground)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(theme.buttonPrimaryText, theme.buttonPrimaryFill)).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it('keeps generated apps/site/stone.css in sync with generateStoneCss()', () => {
    const actual = readFileSync(resolve(REPO_ROOT, 'apps/site/stone.css'), 'utf8');
    expect(actual).toBe(generateStoneCss());
  });

  it('keeps docs/DESIGN.md frontmatter in sync with @beeline/design-tokens and grammar.tsx', () => {
    const designMd = readFileSync(resolve(REPO_ROOT, 'docs/DESIGN.md'), 'utf8');
    const frontmatter = parseDesignFrontmatter(designMd);

    const colors = frontmatter.colors as Record<string, string>;
    expect(colors['brand-mark']).toBe(BRAND_MARK);
    expect(colors['stone-dark-canvas']).toBe(stone.dark.bgBase);
    expect(colors['stone-dark-raised']).toBe(stone.dark.bgRaised);
    expect(colors['stone-dark-unread']).toBe(stone.dark.bgUnread);
    expect(colors['stone-dark-highlight']).toBe(stone.dark.bgHighlight);
    expect(colors['stone-dark-hover']).toBe(stone.dark.bgHover);
    expect(colors['stone-dark-pressed']).toBe(stone.dark.bgPressed);
    expect(colors['stone-dark-border']).toBe(stone.dark.border);
    expect(colors['stone-dark-border-strong']).toBe(stone.dark.borderStrong);
    expect(colors['stone-dark-text-primary']).toBe(stone.dark.textPrimary);
    expect(colors['stone-dark-text-secondary']).toBe(stone.dark.textSecondary);
    expect(colors['stone-dark-ledger-quiet']).toBe(stone.dark.ledgerQuiet);
    expect(colors['stone-dark-text-muted']).toBe(stone.dark.textMuted);
    expect(colors['stone-dark-ledger-ghost']).toBe(stone.dark.ledgerGhost);
    expect(colors['stone-dark-accent']).toBe(stone.dark.accent);
    expect(colors['stone-dark-button-primary-fill']).toBe(stone.dark.buttonPrimaryFill);
    expect(colors['stone-dark-button-primary-text']).toBe(stone.dark.buttonPrimaryText);

    expect(colors['stone-light-canvas']).toBe(stone.light.bgBase);
    expect(colors['stone-light-raised']).toBe(stone.light.bgRaised);
    expect(colors['stone-light-unread']).toBe(stone.light.bgUnread);
    expect(colors['stone-light-highlight']).toBe(stone.light.bgHighlight);
    expect(colors['stone-light-hover']).toBe(stone.light.bgHover);
    expect(colors['stone-light-pressed']).toBe(stone.light.bgPressed);
    expect(colors['stone-light-border']).toBe(stone.light.border);
    expect(colors['stone-light-border-strong']).toBe(stone.light.borderStrong);
    expect(colors['stone-light-text-primary']).toBe(stone.light.textPrimary);
    expect(colors['stone-light-text-secondary']).toBe(stone.light.textSecondary);
    expect(colors['stone-light-ledger-quiet']).toBe(stone.light.ledgerQuiet);
    expect(colors['stone-light-text-muted']).toBe(stone.light.textMuted);
    expect(colors['stone-light-ledger-ghost']).toBe(stone.light.ledgerGhost);
    expect(colors['stone-light-accent']).toBe(stone.light.accent);
    expect(colors['stone-light-button-primary-fill']).toBe(stone.light.buttonPrimaryFill);
    expect(colors['stone-light-button-primary-text']).toBe(stone.light.buttonPrimaryText);

    expect(colors.brass).toBe(brass.obsidian.accent);
    expect(colors['obsidian-canvas']).toBe(brass.obsidian.bgBase);
    expect(colors['obsidian-raised']).toBe(brass.obsidian.bgRaised);
    expect(colors['obsidian-unread']).toBe(brass.obsidian.bgUnread);
    expect(colors['obsidian-highlight']).toBe(brass.obsidian.bgHighlight);
    expect(colors['obsidian-hover']).toBe(brass.obsidian.bgHover);
    expect(colors['obsidian-pressed']).toBe(brass.obsidian.bgPressed);
    expect(colors['obsidian-border']).toBe(brass.obsidian.border);
    expect(colors['obsidian-border-strong']).toBe(brass.obsidian.borderStrong);
    expect(colors['obsidian-text-primary']).toBe(brass.obsidian.textPrimary);
    expect(colors['obsidian-text-secondary']).toBe(brass.obsidian.textSecondary);
    expect(colors['obsidian-ledger-quiet']).toBe(brass.obsidian.ledgerQuiet);
    expect(colors['obsidian-text-muted']).toBe(brass.obsidian.textMuted);
    expect(colors['obsidian-ledger-ghost']).toBe(brass.obsidian.ledgerGhost);

    expect(colors['bone-brass']).toBe(brass.bone.accent);
    expect(colors['bone-canvas']).toBe(brass.bone.bgBase);
    expect(colors['bone-raised']).toBe(brass.bone.bgRaised);
    expect(colors['bone-unread']).toBe(brass.bone.bgUnread);
    expect(colors['bone-highlight']).toBe(brass.bone.bgHighlight);
    expect(colors['bone-border']).toBe(brass.bone.border);
    expect(colors['bone-border-strong']).toBe(brass.bone.borderStrong);
    expect(colors['bone-text-primary']).toBe(brass.bone.textPrimary);
    expect(colors['bone-text-secondary']).toBe(brass.bone.textSecondary);
    expect(colors['bone-ledger-quiet']).toBe(brass.bone.ledgerQuiet);
    expect(colors['bone-text-muted']).toBe(brass.bone.textMuted);
    expect(colors['bone-ledger-ghost']).toBe(brass.bone.ledgerGhost);
    expect(colors['diff-added-obsidian']).toBe(brass.obsidian.diffAdded);
    expect(colors['diff-removed-obsidian']).toBe(brass.obsidian.diffRemoved);
    expect(colors['diff-added-bone']).toBe(brass.bone.diffAdded);
    expect(colors['diff-removed-bone']).toBe(brass.bone.diffRemoved);
    expect(colors['syntax-name-obsidian']).toBe(brass.obsidian.syntaxName);
    expect(colors['syntax-value-obsidian']).toBe(brass.obsidian.syntaxValue);
    expect(colors['syntax-name-bone']).toBe(brass.bone.syntaxName);
    expect(colors['syntax-value-bone']).toBe(brass.bone.syntaxValue);
    expect(colors['dialog-danger']).toBe(brass.obsidian.dialogDanger);

    const typography = frontmatter.typography as Record<string, Record<string, string>>;
    for (const [roleName, role] of Object.entries(typeRoles)) {
      expect(typography[roleName]?.fontFamily).toBe(role.fontFamily);
      expect(typography[roleName]?.fontSize).toBe(`${role.fontSize}px`);
      expect(typography[roleName]?.lineHeight).toBe(`${role.lineHeight}px`);
      expect(typography[roleName]?.letterSpacing).toBe(
        role.letterSpacing === 0 ? '0' : `${role.letterSpacing}px`,
      );
    }

    const rounded = frontmatter.rounded as Record<string, string>;
    expect(rounded.house).toBe(`${radii.house}px`);
    expect(rounded.code).toBe(`${radii.code}px`);
    expect(rounded['transcript-card']).toBe(`${radii.transcript}px`);
    expect(rounded['room-card']).toBe(`${radii.roomCard}px`);
    expect(rounded.viewer).toBe(`${radii.viewer}px`);

    const spacing = frontmatter.spacing as Record<string, string>;
    for (const [stepName, value] of Object.entries(space)) {
      expect(spacing[stepName]).toBe(`${value}px`);
    }

    // Verify docs/DESIGN.md grammar section matches apps/mobile/sources/ui/grammar.tsx.
    const grammarSource = readFileSync(
      resolve(REPO_ROOT, 'apps/mobile/sources/ui/grammar.tsx'),
      'utf8',
    );
    const heightMatch =
      /export const HEIGHT = \{\s*control:\s*(\d+),\s*primary:\s*(\d+),\s*tabBar:\s*(\d+),\s*sheetRow:\s*(\d+)\s*\}/.exec(
        grammarSource,
      );
    expect(heightMatch).not.toBeNull();
    const grammar = frontmatter.grammar as Record<string, string | Record<string, string>>;
    expect(grammar.controlHeight).toBe(`${heightMatch![1]}px`);
    expect(grammar.primaryHeight).toBe(`${heightMatch![2]}px`);
    expect(grammar.tabBarHeight).toBe(`${heightMatch![3]}px`);
    expect(grammar.sheetRowHeight).toBe(`${heightMatch![4]}px`);

    const mediumMatch =
      /medium:\s*roles\(\[(\d+),\s*(\d+)\],\s*\[(\d+),\s*(\d+)\],\s*\[(\d+),\s*(\d+)\],\s*\[(\d+),\s*(\d+)\],\s*\[(\d+),\s*(\d+)\],\s*\[(\d+),\s*(\d+)\]\)/.exec(
        grammarSource,
      );
    expect(mediumMatch).not.toBeNull();
    const expectedMedium: Record<string, [string, string]> = {
      title: [mediumMatch![1]!, mediumMatch![2]!],
      listTitle: [mediumMatch![3]!, mediumMatch![4]!],
      heading: [mediumMatch![5]!, mediumMatch![6]!],
      body: [mediumMatch![7]!, mediumMatch![8]!],
      meta: [mediumMatch![9]!, mediumMatch![10]!],
      metaStrong: [mediumMatch![9]!, mediumMatch![10]!],
      code: [mediumMatch![11]!, mediumMatch![12]!],
    };
    for (const [variant, [size, line]] of Object.entries(expectedMedium)) {
      const entry = grammar[variant] as Record<string, string>;
      expect(entry.fontSize).toBe(`${size}px`);
      expect(entry.lineHeight).toBe(`${line}px`);
    }
  });
});
