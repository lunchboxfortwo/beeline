import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sourceFiles } from './router-boundaries.mjs';

const SERVER = 'apps/server/src/';
const MOBILE = 'apps/mobile/sources/';
const CHAT = MOBILE + 'app/(app)/beeline/chat/';
const WRITER = SERVER + 'system-line.ts';
const RENDERER = CHAT + 'useChatTranscriptRenderer.tsx';
const PILLS = MOBILE + 'components/buzz/TranscriptPills.tsx';

// These are the member publication entry points. Each owns one insert and
// must assert the author before executing it, including the report branch.
const MEMBER_INSERTS = new Map([
  [SERVER + 'message-origin.ts#insertMemberMessage', 'assertMemberTranscript(row.authorId)'],
  [SERVER + 'agent-command.ts#queueMessage', 'assertMemberTranscript(raw.authorId, raw.kind'],
  [SERVER + 'agent-command.ts#postMessage', 'assertMemberTranscript(input.authorId, input.presentation)'],
  [SERVER + 'agent-messaging.ts#sendMessage', 'assertMemberTranscript(input.route.from.agent)'],
  [SERVER + 'daemon/turn-receipts.ts#daemonActivity', 'assertMemberTranscript(agentId)'],
]);

const BODY_COMPONENTS = new Set([
  'LedgerRoomUpdate', 'VaultSaveCard', 'RepositoryOnboardingCard', 'WritePermissionCard',
  'GrantRequestCard', 'SquireApprovalCard', 'ComputerSessionCard', 'AppSignInCard',
  'AgentSignInCard', 'ConnectorOfferCard', 'WalletCards', 'TargetBranchProposalCard',
  'GitHubEventCard', 'DaemonFactCard',
]);

function scope(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
      return { name: parent.name?.getText(source), start: parent.getStart(source) };
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer &&
        (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer))) {
      return { name: parent.name.getText(source), start: parent.getStart(source) };
    }
  }
  return {};
}

function sqlText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map(span => ' $value ' + span.literal.text).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlText(node.left), right = sqlText(node.right);
    if (left !== undefined || right !== undefined) return (left ?? ' $value ') + (right ?? ' $value ');
  }
  return undefined;
}

const TABLE = '(?:ONLY\\s+)?(?:(?:[\\w"]+\\s*\\.\\s*)?"?messages"?)(?![\\w"])';
const INSERT = new RegExp(`\\bINSERT\\s+INTO\\s+${TABLE}\\s*\\(([^)]*)\\)`, 'gi');
const ANY_INSERT = new RegExp(`\\bINSERT\\s+INTO\\s+${TABLE}(?=\\s|\\()`, 'gi');
const MERGE = new RegExp(`\\bMERGE\\s+INTO\\s+${TABLE}(?=\\s|\\()`, 'i');
const UPDATE = new RegExp(`\\bUPDATE\\s+${TABLE}(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET\\b([^;]*)`, 'gi');

function sourceCheck(file, code) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const errors = [];
  const deny = (node, reason) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    errors.push(`${file}:${line}: system transcript boundary: ${reason}`);
  };
  return { source, errors, deny };
}

export function inspectSystemWrites(file, code) {
  if (file.includes('/test-fixtures/')) return [];
  const { source, errors, deny } = sourceCheck(file, code);
  const inserts = new Map();

  function inspectSql(node, sql) {
    const { name, start } = scope(node, source);
    const privateOwner = file === WRITER && name === 'persistSystemRows';
    const key = `${file}#${name}`;
    const prior = code.slice(start, node.getStart(source));
    const insertCount = [...sql.matchAll(ANY_INSERT)].length;
    if (insertCount) {
      inserts.set(key, (inserts.get(key) ?? 0) + insertCount);
      const [insert] = sql.matchAll(INSERT);
      const columns = insert?.[1]?.replaceAll('"', '').toLowerCase().split(',').map(column => column.trim());
      const memberShape = columns?.includes('author_id') &&
        !columns.some(column => ['system_event', 'system_transcript', 'durable_fact'].includes(column)) &&
        !/['"]system['"]|SYSTEM_(?:AUTHOR|IDENTITY)_ID|SCHEDULE_SCHEDULER_ID|\bDO\s+UPDATE\b/i.test(sql);
      const backfill = file === SERVER + 'needs-you-marks.ts' && name === 'needsYouMarksSchema' &&
        sql.includes('DO $blocks$') && node.getText(source).includes(
          "command.private_payload->>'authorId' NOT IN ('${SYSTEM_IDENTITY_ID}','${SCHEDULE_SCHEDULER_ID}')");
      if (inserts.get(key) > 1 || !(privateOwner || memberShape &&
          (backfill || MEMBER_INSERTS.has(key) && prior.includes(MEMBER_INSERTS.get(key))))) {
        deny(node, 'message insert requires systemLine or a guarded member writer');
      }
    }
    if (MERGE.test(sql) && !privateOwner) deny(node, 'message merge requires systemLine');
    for (const [, assignments] of sql.matchAll(UPDATE)) {
      if (privateOwner || file.startsWith(SERVER + 'migrations/')) continue;
      const positional = [...assignments.matchAll(/(?:^|,)\s*\(([^)]+)\)\s*=/g)]
        .flatMap(([, fields]) => fields.split(',').map(field => field.trim().replaceAll('"', '').toLowerCase()));
      const columns = [...assignments.matchAll(/(?:^|,)\s*"?(system_event|system_transcript|presentation|author_id|durable_fact|text)"?\s*=/gi)]
        .map(([, column]) => column.toLowerCase())
        .concat(positional.filter(column => ['system_event', 'system_transcript', 'presentation', 'author_id', 'durable_fact', 'text'].includes(column)));
      if (!columns.length) continue;
      const accountAnonymization = key === SERVER + 'message-origin.ts#anonymizeMessageAuthors' &&
        columns.length === 1 && columns[0] === 'author_id' && prior.includes('assertMemberTranscript(replacement)');
      const memberRevision = key === SERVER + 'voice-service.ts#reviseHuman' && columns.every(column => column === 'text') &&
        /m\.presentation='message' AND m\.system_transcript IS NULL AND m\.system_event IS NULL/.test(assignments);
      const memberDeletion = key === SERVER + 'phone/messages.ts#phoneDeleteRoomMessage' &&
        columns.every(column => column === 'text') && /text=''/.test(assignments) &&
        /message\.presentation='message'/.test(assignments);
      if (!(accountAnonymization || memberRevision || memberDeletion))
        deny(node, 'message text, authorship, event or presentation change requires systemLine');
    }
  }

  function visit(node) {
    const parent = node.parent;
    const inConcatenation = parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const sql = inConcatenation ? undefined : sqlText(node);
    if (sql !== undefined) inspectSql(node, sql);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

export function inspectSystemRenders(file, code) {
  const { source, errors, deny } = sourceCheck(file, code);
  const imported = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const names = statement.importClause?.namedBindings;
    if (!names || !ts.isNamedImports(names)) continue;
    for (const name of names.elements) imported.set(name.name.text, name.propertyName?.text ?? name.name.text);
  }
  let calls = 0;
  const unqualified = value => {
    const name = value?.getText(source).split('.').at(-1);
    return imported.get(name) ?? name;
  };

  function visit(node) {
    const owner = scope(node, source).name;
    const jsx = ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node);
    const factory = ts.isCallExpression(node) && ['createElement', 'jsx', 'jsxs'].includes(unqualified(node.expression));
    const name = unqualified(jsx ? node.tagName : factory ? node.arguments[0] : undefined);
    if (name === 'TranscriptPills') {
      calls++;
      if (file !== RENDERER || owner !== 'renderPills' || !jsx ||
          !node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === 'renderBody' && attribute.initializer?.getText(source) === '{renderSystemBody}')) {
        deny(node, 'TranscriptPills must have one call site with the opened system body');
      }
    }
    if (['LedgerSystemLine', 'NotificationLifecycleCard'].includes(name) &&
        (file !== PILLS || owner !== 'OpenedSystemBody')) deny(node, `${name} must render inside the opened pill`);
    if ((BODY_COMPONENTS.has(name) || ['CornerOpenedMarkers', 'GrantRequestPill'].includes(name)) &&
        (file !== RENDERER || owner !== 'renderSystemBody')) deny(node, `${name} must render inside the opened pill`);
    if (ts.isIdentifier(node) && node.text === 'renderSystemBody' && file === RENDERER &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
        !(ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) &&
          node.parent.parent.name.getText(source) === 'renderBody')) {
      deny(node, 'the system body renderer may only be passed to TranscriptPills');
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (file === RENDERER && calls !== 1) deny(source, `expected one TranscriptPills call, found ${calls}`);
  return errors;
}

export function checkSystemTranscript(root) {
  const files = sourceFiles(root);
  if (files.includes(CHAT + '_chat-surface.tsx') && !files.includes(RENDERER)) {
    return [`${RENDERER}: system transcript boundary: missing the single TranscriptPills call site`];
  }
  return files.flatMap(file => {
    if (!file.startsWith(SERVER) && !file.startsWith(MOBILE)) return [];
    const text = readFileSync(path.join(root, file), 'utf8');
    return file.startsWith(SERVER) ? inspectSystemWrites(file, text) : inspectSystemRenders(file, text);
  });
}
