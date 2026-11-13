// Evaluate the workflow's own expressions with GitHub's expression implementation.
import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Lexer, Parser, Evaluator, data } from '@actions/expressions';

export function evaluate(expression, context, { root, success = true, cancelled = false } = {}) {
  const functions = new Map();
  for (const [name, value] of Object.entries({ always: true, cancelled, success: success && !cancelled, failure: !success })) {
    functions.set(name, { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(value) });
  }
  functions.set('hashfiles', {
    name: 'hashFiles', minArgs: 1, maxArgs: 255,
    call: (...patterns) => {
      const files = [...new Set(patterns.flatMap(p => globSync(p.coerceString(), { cwd: root })))].filter(file => statSync(resolve(root, file)).isFile()).sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(createHash('sha256').update(readFileSync(resolve(root, file))).digest());
      return new data.StringData(files.length ? hash.digest('hex') : '');
    },
  });
  const source = String(expression).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1');
  const ast = new Parser(new Lexer(source).lex().tokens, Object.keys(context), [...functions.values()]).parse();
  const result = new Evaluator(ast, JSON.parse(JSON.stringify(context), data.reviver), functions).evaluate();
  return JSON.parse(JSON.stringify(result, data.replacer));
}

export function render(value, context, options) {
  if (Array.isArray(value)) return value.map(v => render(v, context, options));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, context, options)]));
  if (typeof value !== 'string') return value;
  const expressions = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
  const whole = expressions.length === 1 && expressions[0][0] === value ? expressions[0] : null;
  if (whole) return evaluate(whole[1], context, options) ?? '';
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) => String(evaluate(source, context, options) ?? ''));
}

export function condition(source, context, options) {
  // Actions implicitly applies success() unless a status function is present.
  if (source === undefined) return options.success !== false;
  if (typeof source === 'boolean') return source && options.success !== false;
  if (!/\b(always|cancelled|success|failure)\s*\(/.test(source) && options.success === false) return false;
  return Boolean(evaluate(source, context, options));
}

export function readCommandFile(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const multi = lines[i].match(/^([^=]+)<<(.+)$/);
    if (multi) {
      const values = [];
      while (++i < lines.length && lines[i] !== multi[2]) values.push(lines[i]);
      if (i === lines.length) throw new Error('Unterminated Actions command-file value');
      result[multi[1]] = values.join('\n');
    } else {
      const equals = lines[i].indexOf('=');
      if (equals < 1) throw new Error('Invalid Actions command-file record');
      result[lines[i].slice(0, equals)] = lines[i].slice(equals + 1);
    }
  }
  return result;
}
