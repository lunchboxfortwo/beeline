import { expect, it } from 'vitest';
import { beelineThemes, canvasColor, stonePalette } from './groknight';

it.each([
    ['light', 'brass', beelineThemes.bone.bgBase],
    ['dark', 'brass', beelineThemes.obsidian.bgBase],
    ['light', 'stone', stonePalette.light.bgBase],
    ['dark', 'stone', stonePalette.dark.bgBase],
] as const)('Reproduction STONE-1: the window canvas in %s %s is the colour set\'s own canvas', (mode, palette, expected) => {
    expect(canvasColor(mode, palette)).toBe(expected);
});
