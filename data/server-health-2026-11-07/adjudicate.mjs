// The score counts retained special behavior, not hypothetical removable lines.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const facts = JSON.parse(readFileSync('.beeline-proof/server-health-candidate-facts.json', 'utf8'));
const summary = JSON.parse(readFileSync(directory + 'candidate-summary.json', 'utf8'));
const sourceSha = summary.sourceSha;
const overrides = JSON.parse(readFileSync(directory + 'adjudication-overrides.json', 'utf8'));
const appliedOverrides = new Set();
const ordinary = 'ordinary-control-flow';
const observerSites = new Set([
  'voice-eager-reply.ts:23', 'voice-eager-reply.ts:34', 'voice-providers.ts:175',
  'voice-room-runtime-check-inactivity.ts:166', 'voice-room-runtime-check-inactivity.ts:180',
  'voice-room-runtime-check-inactivity.ts:222', 'voice-room-runtime-refresh-speaking-speed.ts:184',
  'free-agent-model-proxy.ts:454',
]);
const parameterReviews = JSON.parse(readFileSync(directory + 'parameter-adjudications.json', 'utf8'));
const appliedParameterReviews = new Set();
function visit(node, fn) { fn(node); ts.forEachChild(node, n => visit(n, fn)); }
function parseExpression(text) {
  const sf = ts.createSourceFile('site.ts', `const value = (${text});`, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error(`Invalid predicate: ${text}`);
  return sf;
}
function branchReason(text) {
  const sf = parseExpression(text); const reasons = [];
  visit(sf, n => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)) {
      if (ts.isTypeOfExpression(n.left) || ts.isTypeOfExpression(n.right)) return;
      for (const value of [n.left, n.right]) {
        if (ts.isStringLiteralLike(value) && value.text && !['undefined', 'string', 'object', 'number', 'boolean', 'function'].includes(value.text)) reasons.push(value.text);
        if (ts.isNumericLiteral(value) && ![0, 1, 2, -1].includes(Number(value.text))) reasons.push(value.text);
        if (ts.isIdentifier(value) && /^[A-Z][A-Z0-9_]+$/.test(value.text)) reasons.push(value.text);
        if (ts.isPropertyAccessExpression(value) && /^[A-Z][A-Za-z]+\.[A-Z]/.test(value.getText(sf))) reasons.push(value.getText(sf));
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'includes') {
      for (const arg of n.arguments) if (ts.isStringLiteralLike(arg) && arg.text) reasons.push(arg.text);
      if (ts.isArrayLiteralExpression(n.expression.expression)) for (const item of n.expression.expression.elements)
        if (ts.isStringLiteralLike(item) && item.text) reasons.push(item.text);
    }
  });
  // A switch arm is itself the literal dispatch choice, with no equality node.
  if (/^(['"])(.+)\1$/.test(text)) reasons.push(text.slice(1, -1));
  if (/^[A-Z][A-Z0-9_]+$/.test(text) || /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(text) && /\.[A-Z]/.test(text) || /^\d+$/.test(text) && Number(text) > 2) reasons.push(text);
  if (/\b(?:commandTransaction|routingTransaction|atomicCommandWrite|ownedIntent|deferPostCommitObservation)\b/.test(text)) reasons.push('command-scope ownership');
  if (/^(?:ctx\.|this\.|options\.)?(?:live|objects|composio|linkWallet|github|outlineCache)$/.test(text)) reasons.push('configured integration');
  return [...new Set(reasons)];
}
function decide(row) {
  const text = row.evidence, path = row.file.split('/').at(-1), key = `${path}:${row.line}`;
  const overrideKey = row.file.replace('apps/server/', '') + ':' + row.line;
  const override = overrides[overrideKey];
  if (override && override.category === row.category) {
    appliedOverrides.add(overrideKey); return [override.disposition, override.reason];
  }
  if (row.category === 'parameter') {
    const parameterKey = `${row.file.replace('apps/server/', '')}:${row.line}:${row.column}`;
    const review = parameterReviews[parameterKey];
    if (review) {
      if (review.parameter !== row.evidence || review.owner !== row.owner ||
          review.modeKind !== (row.modeKind ?? 'explicit-caller-policy')) {
        throw new Error(`Stale parameter adjudication: ${parameterKey}`);
      }
      appliedParameterReviews.add(parameterKey);
      return [review.disposition, review.reason];
    }
    // Never infer that an unknown mode is harmless from its spelling.
    if (row.modeKind) throw new Error(`Missing parameter adjudication: ${parameterKey}`);
    return [ordinary, `Regular function argument or callback of ${row.owner}, outside the explicitly audited mode/control categories. This classification does not assert that its name proves the absence of a bypass.`];
  }
  if (row.category === 'value-specific-branch') {
    const choices = branchReason(text);
    if (!choices.length) return [ordinary, 'General presence/type/bounds/identity/collection-membership control flow; no singled-out domain value or command-scope mode in this predicate.'];
    return ['retained-value-policy', `${row.owner} selects behavior for ${choices.join(', ')}. Preserve this explicit domain/protocol/provider policy; the factory proposal does not subsume it.`];
  }
  if (row.category === 'sql-case-policy') return ['retained-sql-policy', `${row.owner} selects a persisted/projection value under an explicit SQL CASE/IF/exception condition. Preserve its row-level policy; command-scope construction cannot replace SQL ownership.`];
  if (row.category === 'sql-idempotency') return [ordinary, 'DDL existence checks and ON CONFLICT are ordinary idempotent schema/concurrency mechanics, not a per-caller exception.'];
  if (row.category === 'exception-handler') {
    if (observerSites.has(key)) return [ordinary, 'This observes rejection on a promise whose original consumer still awaits or reports failure; it does not turn that operation into success.'];
    if (row.propagates) return [ordinary, 'The handler ends in an unconditional throw and has no early return/break/continue; cleanup/telemetry/error translation preserves propagation. Nested-function throws are ignored.'];
    if (/\b(?:json|sendJson|mcpJson|publicJson|finish|reject|fail)\s*\(|response\.end|socket\.destroy/.test(text) && !/ROLLBACK|SAVEPOINT/.test(text)) return [ordinary, 'The owning transport/completion boundary reports failure to its caller rather than swallowing it. It terminates or refuses the request.'];
    if (/\.cancel\(\)|\.release\(|\.close\(|cleanup|ROLLBACK|SAVEPOINT|deleteRoom|removeParticipant/.test(text + row.context)) return ['retained-recovery', `Cleanup/rollback/cancellation in ${row.owner} must not mask the original outcome or recreate an already-ended resource. Failure is isolated here.`];
    if (/console\.|captureServerError|\.log\(|\breport\b/.test(text)) return ['retained-recovery', `${row.owner} isolates a background/secondary failure and reports it without converting the committed primary operation into a new attempt.`];
    if (/JSON\.parse|new URL|decodeURIComponent|ipaddr\.|parseCIDR/.test(row.context)) return ['retained-input-policy', `${row.owner} rejects malformed optional/external data or uses its explicit absence value. Untrusted parse failures must not become an accepted partial value.`];
    return ['retained-recovery', `${row.owner} deliberately settles, parks, defaults or isolates this failure path: ${text.slice(0, 250)}. Retain that behavior; no safe removal was established by the factory experiment.`];
  }
  if (row.category === 'disabled-or-conditional-test') {
    if (!/\.(?:skipIf|runIf)\(/.test(text)) return ['retained-test-exception', 'Explicit disabled/todo test; count it as a retained exception rather than assuming coverage.'];
    return ['retained-test-environment', 'The gate requires a real PostgreSQL URL, browser binary, browser proof opt-in or live-wallet opt-in. It prevents substituting a fake backend or making an unintended live request.'];
  }
  if (row.category === 'value-specific-set') {
    return ['retained-value-policy', `The explicit ${text.split('=')[0].trim()} vocabulary defines accepted providers, operations, assets, parsing words or permissions. Preserve that finite policy independently of constructor scope.`];
  }
  if (row.category === 'retry-sleep-or-scheduling-candidate') {
    if (path === 'free-agents.ts') return [ordinary, 'sleep here requests Fly Machine suspension; it is not an execution delay or retry.'];
    if (path === 'owner-schedule-clock.ts') return [ordinary, 'This is the single authorized due-time clock, including timer-range clamping, not a failure retry or a synchronization sleep.'];
    if (path === 'shared-browser-repro.ts' && /setTimeout\(resolve, ms\)/.test(text)) return [ordinary, 'The sleep helper definition; count its invocations, not the underlying timer twice.'];
    if (path.endsWith('.html')) return ['retained-presentation-wait', 'The offline game asset gives the opposing move a visible pacing delay. Preserve the intentional interaction timing; it is not server retry machinery.'];
    return ['retained-proof-wait', 'This offline browser/cutover proof waits for a real process/UI or polls its bounded proof deadline. It does not run in the serving path. Keep it in the server-area census, separately from runtime behavior.'];
  }
  throw new Error(`Unclassified category: ${row.category}`);
}
const ledger = facts.map((row, index) => {
  const [disposition, reason] = decide(row);
  return { id: index + 1, file: row.file, line: row.line, column: row.column, owner: row.owner,
    category: row.category, disposition, counted: disposition !== ordinary, reason, evidence: row.evidence };
});
for (const key of Object.keys(overrides)) if (!appliedOverrides.has(key)) throw new Error(`Unused adjudication override: ${key}`);
for (const key of Object.keys(parameterReviews)) if (!appliedParameterReviews.has(key)) throw new Error(`Unused parameter adjudication: ${key}`);
const byDisposition = {}, byCategory = {};
for (const row of ledger) {
  byDisposition[row.disposition] = (byDisposition[row.disposition] ?? 0) + 1;
  if (row.counted) byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
}
const score = ledger.filter(row => row.counted).length;
const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
writeFileSync(directory + 'semantic-sites.csv', [Object.keys(ledger[0]).join(','), ...ledger.map(row => Object.values(row).map(quote).join(','))].join('\n') + '\n');
writeFileSync(directory + 'semantic-score.json', JSON.stringify({ sourceSha,
  scoringVersion: 'server-retained-special-cases-v2',
  ruleInputs: Object.fromEntries(['inventory.mjs', 'adjudicate.mjs', 'adjudication-overrides.json', 'parameter-adjudications.json'].map(file => [file, createHash('sha256').update(readFileSync(directory + file)).digest('hex')])),
  parameterAudit: { reviewed: appliedParameterReviews.size, modeParameters: facts.filter(row => row.category === 'parameter' && row.modeKind).length },
  score, candidates: ledger.length,
  excluded: ledger.length - score, byDisposition, byCategory,
  meaning: 'Retained value/caller/recovery/compatibility/test/proof special cases; not confirmed defects or a minimum achievable count.',
  nonCodeFiles: summary.nonCodeFiles,
  files: summary.manifest.map(file => ({file: file.file, sha256: file.sha256, candidates: file.sites,
    retained: ledger.filter(row => row.file === file.file && row.counted).length})),
}, null, 2) + '\n');
console.log(JSON.stringify({score, candidates: ledger.length, excluded: ledger.length - score, byDisposition, byCategory}));
