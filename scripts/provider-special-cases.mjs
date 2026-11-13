import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
// Persisted schema values must remain stable across rolling deployments.
const allowed = [
  {
    file: 'apps/server/src/provider-webhooks.ts',
    pattern: /CHECK\(service IN \('linear','stripe'\)\)/g,
    reason: 'Persisted webhook service constraint; no schema change.',
  },
  {
    file: 'apps/server/src/database-schema-corner-facts.ts',
    pattern: /CHECK\s*\(provider IN \([^)]*\)\)/g,
    reason: 'Persisted identity-provider constraints; no schema change.',
  },
  {
    file: 'apps/server/src/database-schema-workflow-backfills.ts',
    pattern: /WHERE link\.provider='github' AND link\.identity_id=identity\.id/g,
    reason: 'Historical identity login backfill predicate.',
  },
  {
    file: 'apps/server/src/database-schema-workflow-backfills.ts',
    pattern:
      /UPDATE identity_external_links SET audience='github'\s+WHERE provider='github' AND audience<>'github';/g,
    reason: 'Historical identity audience backfill values.',
  },
  {
    file: 'apps/server/src/database-migrate.ts',
    pattern: /ON identity_external_links\(identity_id\) WHERE provider='github'/g,
    reason: 'Existing partial identity index is a schema migration.',
  },
];
const providers = resolve(root, 'apps/server/src/providers');
const keys = new Set(
  readdirSync(providers)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((file) => {
      const source = readFileSync(resolve(providers, file), 'utf8');
      return [...source.matchAll(/export const key = ['"]([^'"]+)['"]/g)].map((match) => match[1]);
    }),
);
const refIndex = process.argv.indexOf('--ref');
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
const files = execFileSync(
  'git',
  ref
    ? ['ls-tree', '-r', '--name-only', ref, 'apps/server/src']
    : ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/server/src'],
  { cwd: root, encoding: 'utf8' },
)
  .trim()
  .split('\n');
function sqlLiterals(text) {
  const literals = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text[i] !== "'") continue;
    const offset = i;
    let value = '';
    while (++i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i++;
        } else break;
      } else value += text[i];
    }
    literals.push({ value, offset });
  }
  return literals;
}
const findings = [];
const exemptions = [];
for (const file of [...new Set(files)].sort()) {
  if (!file.endsWith('.ts') || /(?:\.test[.-]|test-support|\/providers\/)/.test(file)) continue;
  const source = ref
    ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(resolve(root, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const ranges = allowed
    .filter((rule) => rule.file === file)
    .flatMap((rule) =>
      [...source.matchAll(rule.pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        reason: rule.reason,
      })),
    );
  const visit = (node) => {
    const start = node.getStart(parsed);
    const add = (key, offset) => {
      const at = start + offset;
      const position = parsed.getLineAndCharacterOfPosition(at);
      const entry = { file, line: position.line + 1, key };
      const exemption = ranges.find((range) => at >= range.start && at < range.end);
      if (exemption) exemptions.push({ ...entry, reason: exemption.reason });
      else findings.push(entry);
    };
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      keys.has(node.text)
    )
      add(node.text, 0);
    // Embedded SQL values, including literals within template expressions.
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // Decode quoted strings before scanning SQL so escaped quotes work too.
      const text = ts.isStringLiteral(node) ? node.text : node.getText(parsed);
      for (const literal of sqlLiterals(text))
        if (keys.has(literal.value))
          add(literal.value, literal.offset + (ts.isStringLiteral(node) ? 1 : 0));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
if (process.argv.includes('--json'))
  console.log(JSON.stringify({ total: findings.length, findings, exemptions }, null, 2));
else {
  for (const file of [...new Set(findings.map((item) => item.file))]) {
    const items = findings.filter((item) => item.file === file);
    console.log(
      `${file} (${items.length}): ${items.map((item) => `${item.line}:${item.key}`).join(', ')}`,
    );
  }
  for (const item of exemptions)
    console.log(`ALLOW ${item.file}:${item.line}:${item.key} — ${item.reason}`);
  console.log(`Total outside providers: ${findings.length}`);
}
