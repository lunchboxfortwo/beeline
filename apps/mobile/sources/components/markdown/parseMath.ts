/**
 * Lightweight, dependency-free LaTeX math parser for MonoMarkdown.
 *
 * Converts common display (`\[...\]`, `$$...$$`) and inline (`\(...\)`)
 * formulas into a small AST for native Tamagui rendering, degrading
 * unsupported/exotic LaTeX (matrices, align environments, integrals,
 * unknown commands) into a clean monospace Unicode representation.
 */

type MathSymbolKind = 'var' | 'op' | 'num' | 'punct' | 'func';

export type MathNode =
  | { type: 'text'; value: string; bold?: boolean }
  | { type: 'symbol'; value: string; kind: MathSymbolKind }
  | { type: 'frac'; num: MathNode[]; den: MathNode[] }
  | { type: 'sup'; base: MathNode[]; exp: MathNode[] }
  | { type: 'sub'; base: MathNode[]; sub: MathNode[] }
  | { type: 'subsup'; base: MathNode[]; sub: MathNode[]; sup: MathNode[] }
  | { type: 'sqrt'; index?: MathNode[]; content: MathNode[] };

type ParsedMath =
  | { kind: 'ast'; nodes: MathNode[] }
  | { kind: 'fallback'; text: string };

const GREEK_AND_CONSTANTS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
};

const OPERATORS: Record<string, string> = {
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  ll: '≪', gg: '≫', times: '×', cdot: '·', centerdot: '·', div: '÷',
  pm: '±', mp: '∓', to: '→', rightarrow: '→', leftarrow: '←', gets: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', implies: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', iff: '⇔', mapsto: '↦',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', forall: '∀', exists: '∃', neg: '¬', lnot: '¬',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗',
  perp: '⊥', parallel: '∥', star: '⋆', ast: '∗', therefore: '∴', because: '∵',
  mid: '|', circ: '∘',
};

const PUNCT_COMMANDS: Record<string, string> = {
  dots: '…', ldots: '…', cdots: '⋯', degree: '°', prime: '′',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  lvert: '|', rvert: '|', lVert: '‖', rVert: '‖',
};

const NAMED_FUNCTIONS = new Set([
  'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'min', 'max', 'sup', 'inf', 'arg', 'det', 'dim', 'gcd', 'lim',
  'mod', 'bmod', 'pmod', 'Pr',
]);

const BIG_OPERATORS: Record<string, string> = {
  int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  sum: '∑', prod: '∏', coprod: '∐',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
};

const BLACKBOARD_BOLD: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ', F: '𝔽', H: 'ℍ',
};

const IGNORED_MODIFIERS = new Set([
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
  'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits',
]);

const TEXT_COMMANDS = new Set([
  'text', 'textrm', 'textnormal', 'mathrm', 'operatorname',
  'mathit', 'textit', 'mathsf', 'mathtt',
]);

const BOLD_TEXT_COMMANDS = new Set(['mathbf', 'textbf', 'boldsymbol', 'bm']);
const SPACING_COMMANDS = new Set(['quad', 'qquad', 'enspace', 'thinspace', 'medspace', 'thickspace', 'space']);
const ESCAPED_LITERALS: Record<string, string> = {
  '%': '%', '$': '$', '{': '{', '}': '}', '_': '_', '&': '&', '#': '#',
};

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', ' ': ' ',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ',
  k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ',
  v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', ' ': ' ',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ',
  p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

function toSuperscript(text: string): string | null {
  if (!text) return null;
  let out = '';
  for (const ch of text) {
    const mapped = SUPERSCRIPT_MAP[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

function toSubscript(text: string): string | null {
  if (!text) return null;
  let out = '';
  for (const ch of text) {
    const mapped = SUBSCRIPT_MAP[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

const ASCII_OPS = new Set(['+', '-', '=', '<', '>']);
const OPEN_PUNCT = new Set(['(', '[', '{', '⟨', '⌊', '⌈']);
const CLOSE_PUNCT = new Set([')', ']', '}', '⟩', '⌋', '⌉', ',', ';', ':', '%', '!', '°', '′']);

function parseMathNodes(input: string): MathNode[] | null {
  let pos = 0;
  let unsupported = false;

  const skipSpaces = () => {
    while (pos < input.length && /\s/.test(input[pos]!)) pos += 1;
  };

  const parseSequence = (stopChar: string | null): MathNode[] => {
    const nodes: MathNode[] = [];
    while (pos < input.length) {
      skipSpaces();
      if (pos >= input.length) break;
      const ch = input[pos]!;
      if (stopChar !== null && ch === stopChar) {
        pos += 1;
        return nodes;
      }
      if ((stopChar === null && ch === '}') || ch === '&') {
        unsupported = true;
        return nodes;
      }
      if (ch === '^' || ch === '_') {
        attachScript(nodes);
        if (unsupported) return nodes;
        continue;
      }
      const atom = parseAtom();
      if (unsupported) return nodes;
      if (atom) nodes.push(...atom);
    }
    if (stopChar !== null) unsupported = true;
    return nodes;
  };

  const attachScript = (nodes: MathNode[]) => {
    let sub: MathNode[] | undefined;
    let sup: MathNode[] | undefined;
    while (pos < input.length) {
      skipSpaces();
      const ch = input[pos];
      if (ch !== '^' && ch !== '_') break;
      pos += 1;
      const arg = parseRequiredArg();
      if (!arg || unsupported) {
        unsupported = true;
        return;
      }
      if (ch === '^') {
        if (sup) { unsupported = true; return; }
        sup = arg;
      } else {
        if (sub) { unsupported = true; return; }
        sub = arg;
      }
    }
    const base = nodes.length > 0 ? [nodes.pop()!] : [];
    if (sub && sup) nodes.push({ type: 'subsup', base, sub, sup });
    else if (sup) nodes.push({ type: 'sup', base, exp: sup });
    else if (sub) nodes.push({ type: 'sub', base, sub });
  };

  const parseRequiredArg = (): MathNode[] | null => {
    skipSpaces();
    if (pos >= input.length) {
      unsupported = true;
      return null;
    }
    if (input[pos] === '{') {
      pos += 1;
      return parseSequence('}');
    }
    const atom = parseAtom();
    return !atom || unsupported ? null : atom;
  };

  const readRawBraceGroup = (): string | null => {
    skipSpaces();
    if (input[pos] !== '{') {
      unsupported = true;
      return null;
    }
    pos += 1;
    let depth = 1;
    let out = '';
    while (pos < input.length && depth > 0) {
      const ch = input[pos]!;
      if (ch === '\\' && pos + 1 < input.length && input[pos + 1]! in ESCAPED_LITERALS) {
        out += ESCAPED_LITERALS[input[pos + 1]!]!;
        pos += 2;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        out += ch;
      } else if (ch === '}') {
        depth -= 1;
        if (depth > 0) out += ch;
      } else {
        out += ch;
      }
      pos += 1;
    }
    if (depth !== 0) {
      unsupported = true;
      return null;
    }
    return out;
  };

  const parseAtom = (): MathNode[] | null => {
    skipSpaces();
    if (pos >= input.length) return null;
    const ch = input[pos]!;

    if (ch === '{') {
      pos += 1;
      return parseSequence('}');
    }
    if (ch === '\\') return parseCommand();

    if (/[0-9]/.test(ch)) {
      const start = pos;
      while (pos < input.length && /[0-9]/.test(input[pos]!)) pos += 1;
      if (input[pos] === '.' && pos + 1 < input.length && /[0-9]/.test(input[pos + 1]!)) {
        pos += 1;
        while (pos < input.length && /[0-9]/.test(input[pos]!)) pos += 1;
      }
      return [{ type: 'symbol', value: input.slice(start, pos), kind: 'num' }];
    }

    if (/[A-Za-z]/.test(ch)) {
      pos += 1;
      return [{ type: 'symbol', value: ch, kind: 'var' }];
    }
    if (ASCII_OPS.has(ch)) {
      pos += 1;
      return [{ type: 'symbol', value: ch === '-' ? '−' : ch, kind: 'op' }];
    }
    if (ch === '/' || ch === '*') {
      pos += 1;
      return [{ type: 'symbol', value: ch === '*' ? '∗' : '/', kind: 'op' }];
    }
    if (ch === "'") {
      pos += 1;
      return [{ type: 'symbol', value: '′', kind: 'punct' }];
    }
    pos += 1;
    return [{ type: 'symbol', value: ch, kind: 'punct' }];
  };

  const parseCommand = (): MathNode[] | null => {
    pos += 1;
    if (pos >= input.length) {
      unsupported = true;
      return null;
    }
    const next = input[pos]!;
    if (next === '\\') {
      unsupported = true;
      return null;
    }
    if (next === ',' || next === ';' || next === ':' || next === '!' || next === ' ') {
      pos += 1;
      return [];
    }
    if (next in ESCAPED_LITERALS) {
      pos += 1;
      return [{ type: 'symbol', value: ESCAPED_LITERALS[next]!, kind: 'punct' }];
    }
    if (!/[A-Za-z]/.test(next)) {
      unsupported = true;
      return null;
    }
    const start = pos;
    while (pos < input.length && /[A-Za-z]/.test(input[pos]!)) pos += 1;
    const name = input.slice(start, pos);

    if (name === 'begin' || name === 'end' || name in BIG_OPERATORS) {
      unsupported = true;
      return null;
    }
    if (IGNORED_MODIFIERS.has(name)) {
      skipSpaces();
      if ((name === 'left' || name === 'right') && input[pos] === '.') pos += 1;
      return [];
    }
    if (SPACING_COMMANDS.has(name)) return [];

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const num = parseRequiredArg();
      if (!num || unsupported) return null;
      const den = parseRequiredArg();
      if (!den || unsupported) return null;
      return [{ type: 'frac', num, den }];
    }
    if (name === 'sqrt') {
      skipSpaces();
      let index: MathNode[] | undefined;
      if (input[pos] === '[') {
        pos += 1;
        index = parseSequence(']');
        if (unsupported) return null;
      }
      const content = parseRequiredArg();
      if (!content || unsupported) return null;
      return [{ type: 'sqrt', ...(index ? { index } : {}), content }];
    }
    if (TEXT_COMMANDS.has(name) || BOLD_TEXT_COMMANDS.has(name)) {
      const value = readRawBraceGroup();
      if (value === null) return null;
      return [{ type: 'text', value, ...(BOLD_TEXT_COMMANDS.has(name) ? { bold: true } : {}) }];
    }
    if (name === 'mathbb') {
      const value = readRawBraceGroup();
      if (value === null) return null;
      return [{ type: 'symbol', value: value.split('').map((c) => BLACKBOARD_BOLD[c] ?? c).join(''), kind: 'var' }];
    }
    if (name in GREEK_AND_CONSTANTS) return [{ type: 'symbol', value: GREEK_AND_CONSTANTS[name]!, kind: 'var' }];
    if (name in OPERATORS) return [{ type: 'symbol', value: OPERATORS[name]!, kind: 'op' }];
    if (name in PUNCT_COMMANDS) return [{ type: 'symbol', value: PUNCT_COMMANDS[name]!, kind: 'punct' }];
    if (NAMED_FUNCTIONS.has(name)) return [{ type: 'symbol', value: name, kind: 'func' }];

    unsupported = true;
    return null;
  };

  const nodes = parseSequence(null);
  return unsupported || pos < input.length ? null : nodes;
}

function isSimpleRootContent(nodes: MathNode[]): boolean {
  if (nodes.length !== 1) return false;
  const only = nodes[0]!;
  return only.type === 'symbol' && (only.kind === 'var' || only.kind === 'num');
}

function formatScript(text: string, kind: 'sup' | 'sub'): string {
  const converted = kind === 'sup' ? toSuperscript(text) : toSubscript(text);
  if (converted !== null) return converted;
  const sigil = kind === 'sup' ? '^' : '_';
  return text.length === 1 && !/\s/.test(text) ? `${sigil}${text}` : `${sigil}(${text})`;
}

function isOpeningPunct(node: MathNode | undefined): boolean {
  return Boolean(node && node.type === 'symbol' && node.kind === 'punct' && OPEN_PUNCT.has(node.value));
}

function isClosingPunct(node: MathNode | undefined): boolean {
  return Boolean(node && node.type === 'symbol' && node.kind === 'punct' && CLOSE_PUNCT.has(node.value));
}

function isUnarySign(node: MathNode, prev: MathNode | undefined): boolean {
  if (node.type !== 'symbol' || node.kind !== 'op') return false;
  if (node.value !== '−' && node.value !== '+' && node.value !== '±') return false;
  if (!prev) return true;
  if (prev.type === 'symbol' && prev.kind === 'op') return true;
  if (isOpeningPunct(prev)) return true;
  return prev.type === 'symbol' && prev.kind === 'punct' && (prev.value === ',' || prev.value === ';');
}

/**
 * Format an AST node list as a single-line Unicode math string (used for
 * inline math spans and compact nested expressions).
 */
export function formatMathNodesInline(nodes: MathNode[], wrapFrac = true): string {
  let out = '';

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    const prev = i > 0 ? nodes[i - 1] : undefined;
    const next = i + 1 < nodes.length ? nodes[i + 1] : undefined;

    if (node.type === 'symbol' && node.kind === 'op') {
      if (isUnarySign(node, prev) || (node.value === '×' && !next)) {
        out += node.value;
      } else {
        if (out.length > 0 && !out.endsWith(' ')) out += ' ';
        out += node.value;
        if (next && !isClosingPunct(next)) out += ' ';
      }
      continue;
    }

    if (node.type === 'symbol' && node.kind === 'func') {
      if (out.length > 0 && !out.endsWith(' ') && !isOpeningPunct(prev)) out += ' ';
      out += node.value;
      if (next && !isOpeningPunct(next) && !isClosingPunct(next) && !(next.type === 'symbol' && next.kind === 'op')) {
        out += ' ';
      }
      continue;
    }

    if (node.type === 'symbol' && node.kind === 'punct') {
      out += (node.value === ',' || node.value === ';') && next ? `${node.value} ` : node.value;
      continue;
    }

    if (out.length > 0 && !out.endsWith(' ') && !isOpeningPunct(prev) && (node.type === 'text' || prev?.type === 'text')) {
      out += ' ';
    }

    switch (node.type) {
      case 'text':
      case 'symbol':
        out += node.value;
        break;
      case 'frac': {
        const numText = formatMathNodesInline(node.num, true);
        const denText = formatMathNodesInline(node.den, true);
        out += wrapFrac ? `(${numText} / ${denText})` : `${numText} / ${denText}`;
        break;
      }
      case 'sqrt': {
        const prefix = node.index ? `${formatScript(formatMathNodesInline(node.index, true), 'sup')}√` : '√';
        const inner = formatMathNodesInline(node.content, true);
        out += isSimpleRootContent(node.content) ? `${prefix}${inner}` : `${prefix}(${inner})`;
        break;
      }
      case 'sup':
        out += `${formatMathNodesInline(node.base, true)}${formatScript(formatMathNodesInline(node.exp, true), 'sup')}`;
        break;
      case 'sub':
        out += `${formatMathNodesInline(node.base, true)}${formatScript(formatMathNodesInline(node.sub, true), 'sub')}`;
        break;
      case 'subsup':
        out += `${formatMathNodesInline(node.base, true)}${formatScript(formatMathNodesInline(node.sub, true), 'sub')}${formatScript(formatMathNodesInline(node.sup, true), 'sup')}`;
        break;
    }
  }

  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function readBraceSpan(text: string, startIndex: number): { inner: string; end: number } | null {
  if (text[startIndex] !== '{') return null;
  let depth = 1;
  let i = startIndex + 1;
  let inner = '';
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length && (text[i + 1] === '{' || text[i + 1] === '}')) {
      inner += text[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      inner += ch;
    } else if (ch === '}') {
      depth -= 1;
      if (depth > 0) inner += ch;
    } else {
      inner += ch;
    }
    i += 1;
  }
  return depth === 0 ? { inner, end: i } : null;
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/**
 * Best-effort readable Unicode monospace rendering for unsupported LaTeX
 * (integrals, matrices, align environments, unknown commands, unbalanced braces).
 */
function formatMonoMath(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const isMultilineEnv = /\\begin\{[^}]+\}/.test(text) || /\\\\/.test(text);
  text = text.replace(/\\begin\{[^}]+\}\s*/g, '').replace(/\s*\\end\{[^}]+\}/g, '').replace(/\\\\/g, '\n');

  const transformSegment = (segment: string): string => {
    let out = '';
    let i = 0;
    while (i < segment.length) {
      const ch = segment[i]!;
      if (ch === '&') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === '\\' && i + 1 < segment.length) {
        const next = segment[i + 1]!;
        if (next === ',' || next === ';' || next === ':' || next === ' ') {
          out += ' ';
          i += 2;
          continue;
        }
        if (next === '!') {
          i += 2;
          continue;
        }
        if (next in ESCAPED_LITERALS) {
          out += ESCAPED_LITERALS[next]!;
          i += 2;
          continue;
        }
        if (/[A-Za-z]/.test(next)) {
          let j = i + 1;
          while (j < segment.length && /[A-Za-z]/.test(segment[j]!)) j += 1;
          const cmd = segment.slice(i + 1, j);

          if (IGNORED_MODIFIERS.has(cmd)) {
            i = j + ((cmd === 'left' || cmd === 'right') && segment[j] === '.' ? 1 : 0);
            continue;
          }
          if (SPACING_COMMANDS.has(cmd)) {
            out += ' ';
            i = j;
            continue;
          }
          if (TEXT_COMMANDS.has(cmd) || BOLD_TEXT_COMMANDS.has(cmd)) {
            const grp = readBraceSpan(segment, skipWs(segment, j));
            if (grp) { out += grp.inner; i = grp.end; continue; }
          }
          if (cmd === 'mathbb') {
            const grp = readBraceSpan(segment, skipWs(segment, j));
            if (grp) {
              out += grp.inner.split('').map((c) => BLACKBOARD_BOLD[c] ?? c).join('');
              i = grp.end;
              continue;
            }
          }
          if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
            const numGrp = readBraceSpan(segment, skipWs(segment, j));
            const denGrp = numGrp ? readBraceSpan(segment, skipWs(segment, numGrp.end)) : null;
            if (numGrp && denGrp) {
              out += `${transformSegment(numGrp.inner).trim()} / ${transformSegment(denGrp.inner).trim()}`;
              i = denGrp.end;
              continue;
            }
          }
          if (cmd === 'sqrt') {
            const grp = readBraceSpan(segment, skipWs(segment, j));
            if (grp) {
              const inner = transformSegment(grp.inner).trim();
              out += inner.length === 1 ? `√${inner}` : `√(${inner})`;
              i = grp.end;
              continue;
            }
          }
          if (cmd in BIG_OPERATORS) { out += BIG_OPERATORS[cmd]!; i = j; continue; }
          if (cmd in GREEK_AND_CONSTANTS) { out += GREEK_AND_CONSTANTS[cmd]!; i = j; continue; }
          if (cmd in OPERATORS) { out += ` ${OPERATORS[cmd]!} `; i = j; continue; }
          if (cmd in PUNCT_COMMANDS) { out += PUNCT_COMMANDS[cmd]!; i = j; continue; }
          if (NAMED_FUNCTIONS.has(cmd)) { out += cmd; i = j; continue; }
          out += `\\${cmd}`;
          i = j;
          continue;
        }
      }

      if (ch === '^' || ch === '_') {
        const kind = ch === '^' ? 'sup' : 'sub';
        const k = skipWs(segment, i + 1);
        if (segment[k] === '{') {
          const grp = readBraceSpan(segment, k);
          if (grp) { out += formatScript(transformSegment(grp.inner).trim(), kind); i = grp.end; continue; }
        } else if (segment[k] === '\\') {
          let j = k + 1;
          while (j < segment.length && /[A-Za-z]/.test(segment[j]!)) j += 1;
          const cmd = segment.slice(k + 1, j);
          const sym = GREEK_AND_CONSTANTS[cmd] ?? OPERATORS[cmd] ?? PUNCT_COMMANDS[cmd];
          if (sym) { out += formatScript(sym, kind); i = j; continue; }
        } else if (k < segment.length && !/\s/.test(segment[k]!)) {
          out += formatScript(segment[k]!, kind);
          i = k + 1;
          continue;
        }
      }

      out += ch === '-' ? '−' : ch;
      i += 1;
    }
    return out;
  };

  if (isMultilineEnv) {
    return text
      .split('\n')
      .map((line) => transformSegment(line).replace(/[ \t]{3,}/g, '  ').trim())
      .filter((line) => line.length > 0)
      .join('\n');
  }
  return transformSegment(text.replace(/\s*\n\s*/g, ' ')).replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Parse a LaTeX math expression (without outer `\[...\]`, `$$...$$`, or `\(...\)`
 * delimiters) into either a structured AST or a clean monospace fallback.
 */
export function parseMath(raw: string): ParsedMath {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'fallback', text: '' };
  const nodes = parseMathNodes(trimmed);
  if (!nodes || nodes.length === 0) {
    return { kind: 'fallback', text: formatMonoMath(trimmed) };
  }
  return { kind: 'ast', nodes };
}

/**
 * Format an inline LaTeX math expression (without outer `\(...\)` delimiters)
 * into a single-line Unicode string safe for prose rendering.
 */
export function formatInlineMath(raw: string): string {
  const parsed = parseMath(raw);
  return parsed.kind === 'fallback'
    ? parsed.text.replace(/\s*\n\s*/g, ' ')
    : formatMathNodesInline(parsed.nodes, true);
}
