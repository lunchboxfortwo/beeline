import { describe, expect, it } from 'vitest';
import { formatInlineMath, parseMath } from './parseMath';
import { parseMarkdown } from './parseMarkdown';
import { parseMarkdownSpans } from './parseMarkdownSpans';

const GENERAL_FORMULA_MARKDOWN = [
  '\\[',
  '\\text{Chinese energy penalty}',
  '<',
  '\\frac{\\text{U.S. electricity price}}{\\text{Chinese electricity price}}',
  '\\]',
].join('\n');

describe('parseMath', () => {
  it('MATH-32188: parses the exact #general equation into an AST with unwrapped text and stacked fraction', () => {
    const parsed = parseMath(
      '\\text{Chinese energy penalty}\n<\n\\frac{\\text{U.S. electricity price}}{\\text{Chinese electricity price}}',
    );
    expect(parsed).toEqual({
      kind: 'ast',
      nodes: [
        { type: 'text', value: 'Chinese energy penalty' },
        { type: 'symbol', value: '<', kind: 'op' },
        {
          type: 'frac',
          num: [{ type: 'text', value: 'U.S. electricity price' }],
          den: [{ type: 'text', value: 'Chinese electricity price' }],
        },
      ],
    });
  });

  it('parses fractions, Greek letters, inequalities, powers, subscripts, and roots', () => {
    const ratio = parseMath('\\Delta P \\le \\frac{P_1 - P_0}{P_0} \\times 100\\%');
    expect(ratio.kind).toBe('ast');
    expect(formatInlineMath('\\Delta P \\le \\frac{P_1 - P_0}{P_0} \\times 100\\%')).toBe(
      'ΔP ≤ (P₁ − P₀ / P₀) × 100%',
    );

    const root = parseMath('\\sigma = \\frac{\\sqrt{s^2}}{\\sqrt{n}} \\approx 1.41 \\times 10^{-3}');
    expect(root.kind).toBe('ast');
    expect(formatInlineMath('\\sigma = \\frac{\\sqrt{s^2}}{\\sqrt{n}} \\approx 1.41 \\times 10^{-3}')).toBe(
      'σ = (√(s²) / √n) ≈ 1.41 × 10⁻³',
    );

    expect(formatInlineMath('\\sqrt[3]{x} + \\mathbb{R}')).toBe('³√x + ℝ');
  });

  it('formats inline math cleanly on one line', () => {
    expect(formatInlineMath('O(n \\log n)')).toBe('O(n log n)');
    expect(formatInlineMath('\\varepsilon \\le 10^{-4}')).toBe('ε ≤ 10⁻⁴');
    expect(formatInlineMath('\\frac{\\text{U.S. price}}{\\text{Chinese price}} \\approx 2.5\\times')).toBe(
      '(U.S. price / Chinese price) ≈ 2.5×',
    );
  });

  it('degrades integrals, matrices, align environments, and unknown commands to clean monospace fallback', () => {
    const integral = parseMath('\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}');
    expect(integral).toEqual({
      kind: 'fallback',
      text: '∫₀^∞ e^(−x²) dx = √π / 2',
    });

    const matrix = parseMath('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
    expect(matrix).toEqual({
      kind: 'fallback',
      text: 'a  b\nc  d',
    });

    const unknown = parseMath('\\xrightarrow{f} y');
    expect(unknown.kind).toBe('fallback');
    const unbalanced = parseMath('\\frac{a}{b');
    expect(unbalanced.kind).toBe('fallback');
    if (unbalanced.kind === 'fallback') expect(unbalanced.text).toContain('a');
  });
});

describe('markdown math blocks and inline spans', () => {
  it('MATH-32188: parses multi-line \\[ ... \\] and $$ ... $$ into a single math-block', () => {
    const blocks = parseMarkdown(`China wins on electricity cost only when:\n\n${GENERAL_FORMULA_MARKDOWN}`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(blocks[1]).toEqual({
      type: 'math-block',
      content: '\\text{Chinese energy penalty}\n<\n\\frac{\\text{U.S. electricity price}}{\\text{Chinese electricity price}}',
    });

    // Also handles blank lines between lines inside \[ ... \] and $$ ... $$
    const withBlankLines = parseMarkdown('\\[\n\n\\text{a}\n\n<\n\n\\frac{1}{2}\n\n\\]');
    expect(withBlankLines).toEqual([{ type: 'math-block', content: '\\text{a}\n\n<\n\n\\frac{1}{2}' }]);

    expect(parseMarkdown('$$ E = mc^2 $$')).toEqual([{ type: 'math-block', content: 'E = mc^2' }]);
    expect(parseMarkdown('$$\n\\alpha + \\beta\n$$')).toEqual([{ type: 'math-block', content: '\\alpha + \\beta' }]);
    expect(parseMarkdown('\\[ a^2 + b^2 = c^2 \\]')).toEqual([{ type: 'math-block', content: 'a^2 + b^2 = c^2' }]);
  });

  it('parses inline \\( ... \\) math while keeping currency amounts and inline code untouched', () => {
    const spans = parseMarkdownSpans(
      'The search runs in \\(O(n \\log n)\\) time with error bound \\(\\varepsilon \\le 10^{-4}\\), keeping per-run cost between $5 and $10 even when tokens hit $0.15/1M and `\\(x + y\\)` stays literal.',
      false,
    );
    expect(spans).toEqual([
      { styles: [], text: 'The search runs in ', url: null },
      { styles: ['math'], text: 'O(n log n)', url: null },
      { styles: [], text: ' time with error bound ', url: null },
      { styles: ['math'], text: 'ε ≤ 10⁻⁴', url: null },
      { styles: [], text: ', keeping per-run cost between $5 and $10 even when tokens hit $0.15/1M and ', url: null },
      { styles: ['code'], text: '\\(x + y\\)', url: null },
      { styles: [], text: ' stays literal.', url: null },
    ]);
  });

  it('keeps fenced code blocks with LaTeX verbatim', () => {
    const blocks = parseMarkdown('```tex\n\\[\n\\frac{\\text{a}}{\\text{b}}\n\\]\n```');
    expect(blocks).toEqual([
      {
        type: 'code-block',
        language: 'tex',
        content: '\\[\n\\frac{\\text{a}}{\\text{b}}\n\\]',
      },
    ]);
  });

  it('is streaming-safe on unclosed display and inline math delimiters', () => {
    const unclosedDisplay = parseMarkdown('\\[\n\\text{Chinese energy penalty}\n<');
    expect(unclosedDisplay.every((block) => block.type === 'text')).toBe(true);

    const unclosedDollars = parseMarkdown('$$\nE = mc^2');
    expect(unclosedDollars.every((block) => block.type === 'text')).toBe(true);

    const unclosedBeforeCode = parseMarkdown('\\[\npartial\n```ts\nconst x = 1;\n```');
    expect(unclosedBeforeCode.some((block) => block.type === 'code-block')).toBe(true);
    expect(unclosedBeforeCode.some((block) => block.type === 'math-block')).toBe(false);

    const unclosedInline = parseMarkdownSpans('Wait for \\(x + 1 and $5', false);
    expect(unclosedInline).toEqual([{ styles: [], text: 'Wait for \\(x + 1 and $5', url: null }]);

    // Standalone currency typo with double dollar never swallows text as math
    expect(parseMarkdown('$$5 and $$10')).toEqual([
      { type: 'text', content: [{ styles: [], text: '$$5 and $$10', url: null }] },
    ]);
  });

  it('protects backtick code spans and autolink URLs during inline math matching', () => {
    // An unfinished `\(` must not consume a `\)` inside a later backtick code span
    expect(parseMarkdownSpans('\\(unfinished then `code\\)`', false)).toEqual([
      { styles: [], text: '\\(unfinished then ', url: null },
      { styles: ['code'], text: 'code\\)', url: null },
    ]);

    // A later valid inline math span still parses after unfinished `\(` + code
    expect(parseMarkdownSpans('\\(unfinished then `code\\)` and \\(x + 1\\)', false)).toEqual([
      { styles: [], text: '\\(unfinished then ', url: null },
      { styles: ['code'], text: 'code\\)', url: null },
      { styles: [], text: ' and ', url: null },
      { styles: ['math'], text: 'x + 1', url: null },
    ]);

    // Bare URL containing `\(x\)` keeps its existing autolink target with no math span
    expect(parseMarkdownSpans('https://example.com/\\(x\\)', false)).toEqual([
      { styles: [], text: 'https://example.com/\\(x\\', url: 'https://example.com/\\(x\\' },
      { styles: [], text: ')', url: null },
    ]);

    expect(parseMarkdownSpans('https://example.com/\\(x\\)/path', false)).toEqual([
      { styles: [], text: 'https://example.com/\\(x\\)/path', url: 'https://example.com/\\(x\\)/path' },
    ]);

    // An unfinished `\(` must not consume a `\)` inside a later URL either
    expect(parseMarkdownSpans('\\(unfinished then https://example.com/a\\)', false)).toEqual([
      { styles: [], text: '\\(unfinished then ', url: null },
      { styles: [], text: 'https://example.com/a\\', url: 'https://example.com/a\\' },
      { styles: [], text: ')', url: null },
    ]);

    // Backtick code (and other Markdown spans) immediately following a bare URL stay separate
    expect(parseMarkdownSpans('https://example.com/`literal`', false)).toEqual([
      { styles: [], text: 'https://example.com/', url: 'https://example.com/' },
      { styles: ['code'], text: 'literal', url: null },
    ]);

    expect(parseMarkdownSpans('https://example.com/**bold**', false)).toEqual([
      { styles: [], text: 'https://example.com/', url: 'https://example.com/' },
      { styles: ['bold'], text: 'bold', url: null },
    ]);

    // An unfinished `\(` before a later closed `\( ... \)` leaves the first plain and parses the second
    expect(parseMarkdownSpans('\\(unfinished then \\(x + 1\\)', false)).toEqual([
      { styles: [], text: '\\(unfinished then ', url: null },
      { styles: ['math'], text: 'x + 1', url: null },
    ]);
  });
});
