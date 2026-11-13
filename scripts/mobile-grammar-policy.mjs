import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { scanVisualSource } from './mobile-visual-policy.mjs';

/**
 * The one design grammar (DESIGN.md → Grammar). Every screen, component and
 * module in apps/mobile/sources may only use these values; the type scale
 * itself lives in GRAMMAR_FILE and nowhere else sets a font, size or weight.
 * Colour values exist only in the token files.
 */
export const GRAMMAR_FILE = 'ui/grammar.tsx';
// The app root lives beside the grammar so screens do not load the gesture runtime.
export const GRAMMAR_FILES = new Set([GRAMMAR_FILE, 'ui/grammar-root.tsx']);
export const TOKEN_FILES = new Set(['ui/tamagui.config.ts', 'buzz/groknight.ts']);

export const COLOR_TOKENS = new Set([
  'canvas', 'raised', 'highlight', 'stroke', 'strongStroke', 'ink', 'secondary',
  'needsYou', 'added', 'removed', 'primaryFill', 'primaryInk', 'transparent',
]);
// 0, 4, 8, 12, 16, 20, 24, 32 and the one 2 px optical nudge.
export const SPACE_TOKENS = new Set(['0', '1', '2', '3', '4', '5', '6', '8', '0.5']);
export const RADIUS_TOKENS = new Set(['sm', 'md', 'lg', 'full', 'transcript', 'viewer']);
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
// `style`, `contentContainerStyle`, `columnWrapperStyle` and every other style-object prop.
const isStyleEscape = (prop, expr) => (prop === 'style' || /[a-z]Style$/.test(prop)) && !(expr && ts.isStringLiteral(expr));
// The component lock: screens compose Tamagui and the grammar, not raw React Native views.
const LOCKED_PRIMITIVES = new Set([
  'View', 'Text', 'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback',
  'TextInput', 'ScrollView', 'SafeAreaView', 'StyleSheet',
]);
const LEGACY_STYLE_MODULES = /^react-native-unistyles(\/|$)/;

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
  // step('3') from useStep(): a spacing step that follows Text size.
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'step'
    && expr.arguments.length === 1 && ts.isStringLiteral(expr.arguments[0]))
    return [{ kind: 'step', value: expr.arguments[0].text }];
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'HEIGHT')
    return [{ kind: 'height', value: expr.name.text }];
  return [{ kind: 'dynamic', value: expr.getText() }];
}

function judge(prop, values) {
  for (const v of values) {
    if (v.kind === 'dynamic') return `${prop} must be a grammar literal, not ${v.value}`;
    if (v.kind === 'step') {
      if (!SPACE_PROPS.has(prop) || !SPACE_TOKENS.has(v.value)) return `${prop}=step(${JSON.stringify(v.value)}) is not a spacing step`;
      continue;
    }
    if (COLOR_PROPS.has(prop)) {
      if (v.kind !== 'string' || !COLOR_TOKENS.has(v.value)) return `${prop}=${JSON.stringify(v.value)} is not a colour token`;
    } else if (SPACE_PROPS.has(prop)) {
      if (!(v.kind === 'string' && SPACE_TOKENS.has(v.value)) && !(v.kind === 'number' && v.value === 0))
        return `${prop}=${JSON.stringify(v.value)} is off the spacing scale (0 4 8 12 16 20 24 32)`;
    } else if (RADIUS_PROPS.has(prop)) {
      if (!(v.kind === 'string' && RADIUS_TOKENS.has(v.value)) && !(v.kind === 'number' && v.value === 0))
        return `${prop}=${JSON.stringify(v.value)} is not a named grammar radius`;
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
  const isGrammar = GRAMMAR_FILES.has(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  errors.push(...scanVisualSource(file, source));
  if (TOKEN_FILES.has(file)) return errors;
  const line = node => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const judgedTypeNodes = new Set();
  const judgeProp = (node, prop, expr) => {
    if (TYPE_PROPS.has(prop) && !isGrammar) {
      if (!judgedTypeNodes.has(node))
        errors.push({ file, line: line(node), rule: 'type-scale', message: `${prop} is set outside the grammar type styles (use <T v=…>)` });
      judgedTypeNodes.add(node);
    }
    else if (isStyleEscape(prop, expr) && !isGrammar)
      errors.push({ file, line: line(node), rule: 'style-escape', message: `${prop} bypasses the grammar; use grammar props` });
    else if (COLOR_PROPS.has(prop) || SPACE_PROPS.has(prop) || RADIUS_PROPS.has(prop) || prop === 'minHeight') {
      // The grammar file composes its primitives from typed props; only its literals are judged.
      const values = literalValues(expr).filter(v => !(isGrammar && v.kind === 'dynamic'));
      const problem = judge(prop, values);
      if (problem) errors.push({ file, line: line(node), rule: 'off-grammar', message: problem });
    }
  };
  // styled(Component, { ...props, variants: { ... } }) is judged like JSX props.
  const judgeStyledObject = object => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replace(/^['"]|['"]$/g, '');
      if (ts.isObjectLiteralExpression(property.initializer)) judgeStyledObject(property.initializer);
      else judgeProp(property, name, property.initializer);
    }
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || isGrammar) continue;
    const from = statement.moduleSpecifier.text;
    if (LEGACY_STYLE_MODULES.test(from))
      errors.push({ file, line: line(statement), rule: 'legacy-styles', message: `${from} is the old theme; use Tamagui and the grammar` });
    if (from !== 'react-native') continue;
    const names = statement.importClause?.namedBindings;
    if (!names || !ts.isNamedImports(names) || statement.importClause.isTypeOnly) continue;
    for (const element of names.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      if (LOCKED_PRIMITIVES.has(name))
        errors.push({ file, line: line(element), rule: 'component-lock', message: `react-native ${name} is locked; use the Tamagui and grammar components` });
    }
  }
  const visit = node => {
    // StyleSheet/plain objects and later assignments must not bypass JSX checks.
    let faceName;
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
      faceName = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = node.left;
      if (ts.isPropertyAccessExpression(target)) faceName = target.name.text;
      else if (ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression))
        faceName = target.argumentExpression.text;
    }
    if (faceName === 'fontFamily' || faceName === 'fontWeight') judgeProp(node, faceName);
    if (ts.isStringLiteral(node) && /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(node.text) && !isGrammar)
      errors.push({ file, line: line(node), rule: 'colour-literal', message: `${node.text} is not a theme token` });
    if (ts.isJsxAttribute(node)) {
      const expr = node.initializer && (ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
      judgeProp(node, node.name.getText(), expr);
    }
    // {...{ style: x }} spreads are judged like the props they spread.
    if (ts.isJsxSpreadAttribute(node) && ts.isObjectLiteralExpression(node.expression))
      for (const property of node.expression.properties)
        if (ts.isPropertyAssignment(property)) judgeProp(property, property.name.getText().replace(/^['"]|['"]$/g, ''), property.initializer);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'styled') {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) judgeStyledObject(options);
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

/** Scan every module in apps/mobile/sources under a repository root. */
export function scanGrammarTree(root) {
  const sources = path.join(root, 'apps/mobile/sources');
  const errors = [];
  for (const full of walk(sources)) {
    const file = path.relative(sources, full).split(path.sep).join('/');
    errors.push(...scanGrammarSource(file, readFileSync(full, 'utf8')));
  }
  return errors;
}
