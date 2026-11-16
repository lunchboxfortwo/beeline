import { describe, expect, it } from 'vitest';
import {
  CORNER_NAME_MAX_WORDS,
  CORNER_OBJECTIVE_MAX_WORDS,
  cornerDisplayName,
  cornerTextRefusal,
  fixCornerText,
  normalizeCornerText,
} from './corner-text.js';

describe('corner text normalisation', () => {
  it('flattens the untidy shapes that used to be refused outright', () => {
    // The exact brief that silently killed two grok turns (C90).
    expect(
      normalizeCornerText(
        'Ship the corner name parameter.\nMake grok able to open a corner.\nUpdate every surface.',
      ),
    ).toBe('Ship the corner name parameter. Make grok able to open a corner. Update every surface.');
    expect(normalizeCornerText('  two  spaces\tand a tab ')).toBe('two spaces and a tab');
    expect(normalizeCornerText('\r\nleading and trailing\r\n')).toBe('leading and trailing');
  });

  it('accepts a normalised objective that only looked malformed', () => {
    expect(cornerTextRefusal('objective', 'Fix the ledger drift\nin the room list')).toBeUndefined();
    expect(cornerTextRefusal('name', 'ledger-drift')).toBeUndefined();
  });
});

describe('corner text fixes', () => {
  it.each([' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u2028', '\ufeff'])('joins whitespace %j in names', (separator) => {
    expect(fixCornerText('name', `continuous${separator}amber-corner`)).toEqual({
      text: 'continuous-amber-corner',
      note: 'the name had spaces; saved as continuous-amber-corner',
    });
  });

  it('cuts a long name and a long objective on a word boundary', () => {
    const objective = Array.from({ length: 61 }, (_, index) => `word${index}`).join(' ');
    const fixedObjective = fixCornerText('objective', objective);
    expect(fixedObjective.text.split(' ')).toHaveLength(24);
    expect(fixedObjective.text.startsWith('word0 ')).toBe(true);
    expect(fixedObjective.note).toContain('61 words');
    expect(fixedObjective.note).toContain('word boundary');
    expect(fixCornerText('name', 'far too many words here')).toEqual({
      text: 'far-too-many',
      note: 'the name had spaces and was 5 words; saved as far-too-many (first 3 words)',
    });
    expect(fixCornerText('name', 'grunt-creature-rpg-failure-experiment')).toEqual({
      text: 'grunt-creature-rpg',
      note: 'the name had spaces and was 5 words; saved as grunt-creature-rpg (first 3 words)',
    });
    expect(fixCornerText('name', 'one-two-three').note).toBeUndefined();
    expect(cornerTextRefusal('name', 'one-two-three-four')).toBe('the name is 4 words; the limit is 3');
    expect(cornerTextRefusal('name', 'one-two-three')).toBeUndefined();
    const long = fixCornerText('name', 'a'.repeat(200));
    expect(long.text).toHaveLength(120);
    expect(long.note).toContain('200 characters');
  });

  it('names a missing text rather than staying silent', () => {
    expect(cornerTextRefusal('name', undefined)).toBe(
      'the name is required; give a title of at most 3 words',
    );
    expect(cornerTextRefusal('objective', '   \n  ')).toBe(
      'the objective is required; give one statement of at most 24 words',
    );
  });

  it('names an over-long text by its character count', () => {
    expect(cornerTextRefusal('name', 'a'.repeat(200))).toBe(
      'the name is 200 characters; the limit is 120',
    );
  });

  it('holds the two limits apart', () => {
    expect(CORNER_NAME_MAX_WORDS).toBe(3);
    expect(CORNER_OBJECTIVE_MAX_WORDS).toBe(24);
  });
});

describe('cornerDisplayName', () => {
  it('leaves a real name alone', () => {
    expect(cornerDisplayName('ledger drift fix')).toBe('ledger drift fix');
  });

  it('stands in for a legacy corner by cutting on a word boundary', () => {
    expect(
      cornerDisplayName(
        'Rework the room list so every corner row carries its own state mark and preview',
      ),
    ).toBe('Rework the room');
  });

  it('never renders a blank title as something', () => {
    expect(cornerDisplayName(undefined)).toBe('');
    expect(cornerDisplayName('   ')).toBe('');
  });
});
