// Source discovery for the pinned census; adjudicate.mjs assigns the policy dispositions.
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const directory = fileURLToPath(new URL('.', import.meta.url));
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '00b345c83b2ad74cb0eacd496c02a3e2d66a4984', 'apps/server'], { encoding: 'utf8' }).trim().split('\n');
const rows = [], manifest = [];
const sourceSha = '00b345c83b2ad74cb0eacd496c02a3e2d66a4984';
const objects = execFileSync('git', ['cat-file', '--batch'], {
  input: files.map(file => `${sourceSha}:${file}`).join('\n') + '\n', maxBuffer: 40 * 1024 * 1024,
});
const sources = new Map(); let position = 0;
for (const file of files) {
  const end = objects.indexOf(10, position);
  const size = Number(objects.subarray(position, end).toString().split(' ').at(-1));
  if (!Number.isFinite(size)) throw new Error(`Missing source: ${file}`);
  sources.set(file, objects.subarray(end + 1, end + 1 + size).toString()); position = end + size + 2;
}
for (const file of files) {
  if (!/\.(?:[cm]?js|tsx?|html)$/.test(file) || /\/dist\//.test(file)) continue;
  const test = /(?:\.test\.|test-support|test-fixtures|\/fixtures\/)/.test(file);
  const source = sources.get(file);
  const physical = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const before = rows.length;
  function scan(unit, mapping, embedded = false) {
  const sf = ts.createSourceFile(file, unit, ts.ScriptTarget.Latest, true,
    embedded ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length) throw new Error(`Parse failed: ${file} (${embedded ? 'embedded' : 'source'}) at ${mapping[0]}: ${sf.parseDiagnostics.map(d => d.messageText).join(';')}`);
  function add(node, category, evidence, disposition = 'discovered', offset = node.getStart(sf)) {
    const pos = physical.getLineAndCharacterOfPosition(mapping[offset] ?? source.length);
    let owner = node.parent;
    while (owner && !(ts.isFunctionLike(owner) && (owner.name ||
      ts.isVariableDeclaration(owner.parent) || ts.isPropertyAssignment(owner.parent) || ts.isConstructorDeclaration(owner)))) owner = owner.parent;
    const ownerName = owner?.name?.getText(sf) ?? (owner && ts.isConstructorDeclaration(owner)
      ? (owner.parent.name?.getText(sf) ?? '(class)') + '.constructor'
      : owner?.parent?.name?.getText(sf)) ?? '(module)';
    rows.push({ owner: ownerName, file, line: pos.line + 1, column: pos.character + 1, category, disposition,
      evidence,
      context: source.slice(Math.max(0, (mapping[node.getStart(sf)] ?? 0) - 240), Math.min(source.length, (mapping[node.end] ?? source.length) + 120)).replace(/\s+/g, ' ').slice(0, 2400) });
  }
  function handler(node, body) {
    if (!body) return;
    let earlyReturn = false;
    function returns(n) {
      if (n !== body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) || ts.isContinueStatement(n) || ts.isBreakStatement(n)) earlyReturn = true;
      ts.forEachChild(n, returns);
    }
    returns(body);
    add(node, 'exception-handler', body.getText(sf));
    rows.at(-1).propagates = ts.isBlock(body) && !earlyReturn &&
      !!body.statements.length && ts.isThrowStatement(body.statements.at(-1));
  }
  function walk(n) {
    if (!test) {
      if (!embedded && (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n))) {
        const raw = n.getText(sf);
        if (raw.includes('<script') || ts.isVariableDeclaration(n.parent) && /_SCRIPT$/.test(n.parent.name.getText(sf))) {
          const chars = raw.split('');
          if (ts.isTemplateExpression(n)) n.templateSpans.forEach((span, index) => {
            const start = (index ? n.templateSpans[index - 1].literal.end : n.head.end) - 2 - n.getStart(sf);
            const end = span.literal.getStart(sf) + 1 - n.getStart(sf);
            for (let at = start; at < end; at++) if (!/[\r\n]/.test(chars[at])) chars[at] = at === start ? '0' : ' ';
          });
          const cooked = [], positions = [];
          for (let at = 1; at < chars.length - 1; at++) {
            const position = mapping[n.getStart(sf) + at]; let value = chars[at];
            if (value === '\\' && at + 1 < chars.length - 1) {
              const next = chars[++at];
              if (next === '\n') continue;
              value = ({n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v'})[next] ?? next;
            }
            cooked.push(value); positions.push(position);
          }
          const code = cooked.join('');
          if (raw.includes('<script')) scanHtml(code, positions);
          else scan(code, positions, true);
        }
      }
      if (ts.isIfStatement(n)) add(n, 'value-specific-branch', n.expression.getText(sf));
      if (ts.isConditionalExpression(n)) add(n, 'value-specific-branch', n.condition.getText(sf));
      if (ts.isCaseClause(n)) add(n, 'value-specific-branch', n.expression.getText(sf));
      if (ts.isCatchClause(n)) handler(n, n.block);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
        const fn = n.arguments[0];
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) handler(n, fn.body);
        else add(n, 'exception-handler', n.getText(sf));
      }
      if (ts.isParameter(n)) {
        add(n, 'parameter', n.getText(sf));
        const directBoolean = type => type && (type.kind === ts.SyntaxKind.BooleanKeyword ||
          ts.isUnionTypeNode(type) && type.types.some(directBoolean));
        const selectors = type => type && ts.isUnionTypeNode(type) && type.types.some(item =>
          ts.isLiteralTypeNode(item) && (ts.isStringLiteralLike(item.literal) || ts.isNumericLiteral(item.literal)));
        const booleanWithin = type => {
          if (!type) return false;
          if (type.kind === ts.SyntaxKind.BooleanKeyword) return true;
          return !!ts.forEachChild(type, booleanWithin);
        };
        rows.at(-1).modeKind = directBoolean(n.type) || n.initializer &&
          [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(n.initializer.kind) ? 'boolean' :
          selectors(n.type) ? 'literal-selector' : booleanWithin(n.type) ? 'nested-controls' : undefined;
      }
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'Set' &&
          n.arguments?.some(arg => ts.isArrayLiteralExpression(arg) && arg.elements.some(item =>
            ts.isStringLiteralLike(item) || ts.isIdentifier(item) && /^[A-Z][A-Z0-9_]+$/.test(item.text)))) {
        add(n, 'value-specific-set', n.parent.getText(sf));
      }
      if (ts.isCallExpression(n) && /(?:^|\.)(?:sleep|delay|retry|setTimeout|setInterval)$/.test(n.expression.getText(sf))) {
        add(n, 'retry-sleep-or-scheduling-candidate', n.getText(sf));
      }
      if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && /\b(?:SELECT|UPDATE|INSERT|CREATE|ALTER|DELETE|CASE\s+WHEN)\b/.test(n.getText(sf))) {
        const text = n.getText(sf);
        // Mask comments and quoted SQL values without moving source offsets.
        const sqlChars = (' ' + text.slice(1, -1) + ' ').split('');
        if (ts.isTemplateExpression(n)) n.templateSpans.forEach((span, index) => {
          const start = (index ? n.templateSpans[index - 1].literal.end : n.head.end) - 2 - n.getStart(sf);
          const end = span.literal.getStart(sf) + 1 - n.getStart(sf);
          for (let at = start; at < end; at++) if (!/[\r\n]/.test(sqlChars[at])) sqlChars[at] = ' ';
        });
        const inside = sqlChars.join('');
        const sql = inside.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|\bEND\s+IF\b/gi,
          value => value.replace(/[^\n]/g, ' '));
        for (const match of sql.matchAll(/\bCASE\b|\bON CONFLICT\b|\bIF (?:NOT )?EXISTS\b|\b(?:IF|ELSIF)\b|\bEXCEPTION\s+WHEN\b/gi)) {
          const prefix = sql.slice(Math.max(0, match.index - 120), match.index);
          const ddlExists = /^IF (?:NOT )?EXISTS/i.test(match[0]) && /\b(?:CREATE|ALTER|DROP)\b[^;]*$/i.test(prefix);
          const category = /^ON CONFLICT/i.test(match[0]) || ddlExists ? 'sql-idempotency' : 'sql-case-policy';
          add(n, category, text.slice(match.index, match.index + 240), 'discovered', n.getStart(sf) + match.index);
        }
      }
    }
    if (test && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(?:it|test|describe)\.(?:skip|todo|skipIf|runIf)$/.test(n.expression.getText(sf))) {
      add(n, 'disabled-or-conditional-test', n.expression.getText(sf) + '(' + n.arguments.map(a => a.getText(sf).slice(0,160)).join(',') + ')');
    }
    ts.forEachChild(n, walk);
  }
  walk(sf);
  }
  function scanHtml(html, mapping) {
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/application\/json/.test(match[1])) continue;
      const start = match.index + match[0].indexOf('>') + 1;
      scan(match[2], mapping.slice(start, start + match[2].length), true);
    }
  }
  const mapping = Array.from({length: source.length}, (_, index) => index);
  if (file.endsWith('.html')) scanHtml(source, mapping); else scan(source, mapping);
  manifest.push({ file, test, sites: rows.length - before, sha256: createHash('sha256').update(source).digest('hex') });
}
const counts = {}, dispositions = {};
for (const row of rows) {
  counts[row.category] = (counts[row.category] ?? 0) + 1;
  dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
}
mkdirSync('.beeline-proof', { recursive: true });
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
const columns = ['owner', 'file', 'line', 'column', 'category', 'disposition', 'evidence'];
writeFileSync(directory + 'candidate-sites.csv', [columns.join(','),
  ...rows.map(row => columns.map(key => quote(row[key])).join(','))].join('\n') + '\n');
writeFileSync('.beeline-proof/server-health-candidate-facts.json', JSON.stringify(rows) + '\n');
const summary = { sourceSha,
  status: 'discovery ledger; semantic adjudications and exclusions are in semantic-sites.csv',
  nonCodeFiles: files.filter(file => !manifest.some(item => item.file === file)).map(file => ({ file, reason: /\.sql$/.test(file) ? 'Proof/test SQL fixture; serving SQL is embedded in the scanned TS sources.' : file.endsWith('/Dockerfile') ? 'Build recipe; its certificate assertion and build steps are ordinary prerequisites.' : 'Static asset, declarative data, documentation, snapshot or package/build metadata.' })),
  files: manifest.length, candidates: rows.length, counts, dispositions, manifest };
writeFileSync(directory + 'candidate-summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ files: manifest.length, candidates: rows.length, counts, dispositions }));
