import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * The one design grammar (DESIGN.md → Grammar). Every Tamagui surface in
 * apps/mobile/sources may only use these values; the type scale itself lives
 * in GRAMMAR_FILE and nowhere else sets a font, size or weight.
 */
export const GRAMMAR_FILE = 'ui/grammar.tsx';
export const CONFIG_FILE = 'ui/tamagui.config.ts';

export const COLOR_TOKENS = new Set([
  'canvas', 'raised', 'highlight', 'stroke', 'strongStroke', 'ink', 'secondary',
  'needsYou', 'added', 'removed', 'primaryFill', 'primaryInk', 'transparent',
]);
// 0, 4, 8, 12, 16, 20, 24, 32 and the one 2 px optical nudge.
export const SPACE_TOKENS = new Set(['0', '1', '2', '3', '4', '5', '6', '8', '0.5']);
export const RADIUS_TOKENS = new Set(['sm', 'md', 'lg', 'full']);
export const CONTROL_HEIGHTS = new Set([44, 48, 52, 56]);

const TYPE_PROPS = new Set(['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontStyle']);
const COLOR_PROPS = new Set([
  'color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor',
  'borderRightColor', 'outlineColor', 'placeholderTextColor', 'shadowColor',
]);
const SPACE_PROPS = new Set([
  'padding', 'paddingHorizontal', 'paddingVertical', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'margin', 'marginHorizontal', 'marginVertical', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'gap', 'rowGap', 'columnGap', 'space',
]);
const RADIUS_PROPS = new Set([
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
]);
const STYLE_ESCAPES = new Set(['style', 'contentContainerStyle']);

function literalValues(expr) {
  if (!expr) return [];
  if (ts.isParenthesizedExpression(expr)) return literalValues(expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ kind: 'string', value: expr.text }];
  if (ts.isNumericLiteral(expr)) return [{ kind: 'number', value: Number(expr.text) }];
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand))
    return [{ kind: 'number', value: -Number(expr.operand.text) }];
  if (ts.isConditionalExpression(expr)) return [...literalValues(expr.whenTrue), ...literalValues(expr.whenFalse)];
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(expr) && expr.text === 'undefined')) return [];
  if (ts.isAsExpression(expr)) return literalValues(expr.expression);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'HEIGHT')
    return [{ kind: 'height', value: expr.name.text }];
  return [{ kind: 'dynamic', value: expr.getText() }];
}

function judge(prop, values) {
  for (const v of values) {
    if (v.kind === 'dynamic') return `${prop} must be a grammar literal, not ${v.value}`;
    if (COLOR_PROPS.has(prop)) {
      if (v.kind !== 'string' || !COLOR_TOKENS.has(v.value)) return `${prop}=${JSON.stringify(v.value)} is not a colour token`;
    } else if (SPACE_PROPS.has(prop)) {
      if (!(v.kind === 'string' && SPACE_TOKENS.has(v.value)) && !(v.kind === 'number' && v.value === 0))
        return `${prop}=${JSON.stringify(v.value)} is off the spacing scale (0 4 8 12 16 20 24 32)`;
    } else if (RADIUS_PROPS.has(prop)) {
      if (!(v.kind === 'string' && RADIUS_TOKENS.has(v.value)) && !(v.kind === 'number' && v.value === 0))
        return `${prop}=${JSON.stringify(v.value)} is not sm, md, lg or full`;
    } else if (prop === 'minHeight') {
      if (!(v.kind === 'height') && !(v.kind === 'number' && (CONTROL_HEIGHTS.has(v.value) || v.value === 0)))
        return `minHeight=${JSON.stringify(v.value)} is not a control height (44, 48, 52, 56)`;
    }
  }
  return undefined;
}

/** Scan one source text; returns violations with 1-based lines. */
export function scanGrammarSource(file, text) {
  const errors = [];
  if (file === CONFIG_FILE) return errors;
  const isGrammar = file === GRAMMAR_FILE;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const usesTamagui = source.statements.some(s => ts.isImportDeclaration(s) && /^(tamagui|@tamagui\/)/.test(s.moduleSpecifier.text));
  const usesGrammar = source.statements.some(s => ts.isImportDeclaration(s) && /(^|\/)ui\/grammar$/.test(s.moduleSpecifier.text));
  if (!usesTamagui && !usesGrammar) return errors;
  const line = node => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = node => {
    if (ts.isStringLiteral(node) && /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(node.text) && !isGrammar)
      errors.push({ file, line: line(node), rule: 'colour-literal', message: `${node.text} is not a theme token` });
    if (ts.isJsxAttribute(node)) {
      const prop = node.name.getText();
      const expr = node.initializer && (ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
      if (TYPE_PROPS.has(prop) && !isGrammar)
        errors.push({ file, line: line(node), rule: 'type-scale', message: `${prop} is set outside the six type styles (use <T v=…>)` });
      else if (STYLE_ESCAPES.has(prop) && !isGrammar)
        errors.push({ file, line: line(node), rule: 'style-escape', message: `${prop} bypasses the grammar; use grammar props` });
      else if (COLOR_PROPS.has(prop) || SPACE_PROPS.has(prop) || RADIUS_PROPS.has(prop) || prop === 'minHeight') {
        // The grammar file composes its primitives from typed props; only its literals are judged.
        const values = literalValues(expr).filter(v => !(isGrammar && v.kind === 'dynamic'));
        const problem = judge(prop, values);
        if (problem) errors.push({ file, line: line(node), rule: 'off-grammar', message: problem });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'vendor' && name !== 'node_modules') walk(full, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|test-support)\.[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Scan apps/mobile/sources under a repository root. */
export function scanGrammarTree(root) {
  const sources = path.join(root, 'apps/mobile/sources');
  const errors = [];
  for (const full of walk(sources)) {
    const file = path.relative(sources, full).split(path.sep).join('/');
    errors.push(...scanGrammarSource(file, readFileSync(full, 'utf8')));
  }
  return errors;
}
