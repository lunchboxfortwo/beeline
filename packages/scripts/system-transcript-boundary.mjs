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
  [SERVER + 'answer-activity.ts#holdFinalAfterReply', 'assertMemberTranscript(input.agentId)'],
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
const TRANSCRIPT_COLUMNS = new Set([
  'system_event', 'system_transcript', 'presentation', 'author_id', 'durable_fact', 'text', 'deleted_at', 'deleted_by',
]);
const ASSIGNMENT = new RegExp(`(?:^|,)\\s*"?(${[...TRANSCRIPT_COLUMNS].join('|')})"?\\s*=`, 'gi');

/** Treat PostgreSQL comments as whitespace, preserving comment markers in quoted strings. */
function stripSqlComments(sql) {
  const tokens = /\bE'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|(\/\*|--[^\r\n]*)/gi;
  const block = /\/\*|\*\//g;
  let result = '', end = 0;
  for (let match; (match = tokens.exec(sql));) {
    if (!match[1]) continue;
    result += sql.slice(end, match.index) + ' ';
    if (match[1] === '/*') {
      block.lastIndex = tokens.lastIndex;
      let depth = 1;
      for (let marker; depth && (marker = block.exec(sql));) depth += marker[0] === '/*' ? 1 : -1;
      tokens.lastIndex = depth ? sql.length : block.lastIndex;
    }
    end = tokens.lastIndex;
  }
  return result + sql.slice(end);
}

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

  function inspectSql(node, rawSql) {
    if (!/\b(?:INSERT|MERGE|UPDATE)\b/i.test(rawSql)) return;
    const sql = stripSqlComments(rawSql);
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
        !columns.some(column => ['system_event', 'system_transcript', 'durable_fact', 'deleted_at', 'deleted_by'].includes(column)) &&
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
      const columns = [...assignments.matchAll(ASSIGNMENT)]
        .map(([, column]) => column.toLowerCase())
        .concat(positional.filter(column => TRANSCRIPT_COLUMNS.has(column)));
      if (!columns.length) continue;
      const accountAnonymization = key === SERVER + 'message-origin.ts#anonymizeMessageAuthors' &&
        columns.length === 1 && columns[0] === 'author_id' && prior.includes('assertMemberTranscript(replacement)');
      const memberRevision = key === SERVER + 'voice-service.ts#reviseHuman' && columns.every(column => column === 'text') &&
        /m\.presentation='message' AND m\.system_transcript IS NULL AND m\.system_event IS NULL/.test(assignments);
      if (!(accountAnonymization || memberRevision))
        deny(node, 'message text, authorship, deletion, event or presentation change requires systemLine');
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

function contains(node, matches) {
  return Boolean(node && (matches(node) || ts.forEachChild(node, child => contains(child, matches) || undefined)));
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
  const element = node => ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node);
  const factory = node => ts.isCallExpression(node) && ['createElement', 'jsx', 'jsxs'].includes(unqualified(node.expression));
  const component = node => unqualified(element(node) ? node.tagName : factory(node) ? node.arguments[0] : undefined);
  const noticeFields = new Set(['isSystemNotice', 'systemTranscript', 'systemEvent']);
  const noticeSelector = node => {
    if (ts.isIdentifier(node)) return noticeFields.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return noticeFields.has(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return noticeFields.has(node.argumentExpression.text);
    if (ts.isCallExpression(node)) return unqualified(node.expression) === 'isSystemLine';
    if (ts.isBinaryExpression(node) && ts.isStringLiteralLike(node.right) && node.right.text === 'system') {
      return ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'presentation';
    }
    return false;
  };

  function guardedCardBody(node) {
    if (file !== RENDERER || !node || !element(node) || component(node) !== 'TranscriptSystemBody') return false;
    const message = node.attributes.properties.find(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'message')?.initializer?.expression;
    if (!message || !ts.isIdentifier(message)) return false;
    for (let child = node; child.parent; child = child.parent) {
      const parent = child.parent;
      if (ts.isFunctionLike(parent)) break;
      if (!ts.isIfStatement(parent) || parent.thenStatement !== child) continue;
      let condition = parent.expression;
      while (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        condition = condition.left;
      if (ts.isCallExpression(condition) && unqualified(condition.expression) === 'hasCardBody' &&
          condition.arguments.length === 1 && condition.arguments[0].getText(source) === message.text) return true;
    }
    return false;
  }

  function visit(node) {
    const owner = scope(node, source).name;
    const jsx = element(node);
    const name = component(node);
    const buildsOpenedBody = file === PILLS && owner === 'pillItem';
    if (name === 'TranscriptSystemBody' && !buildsOpenedBody && !guardedCardBody(node))
      deny(node, 'TranscriptSystemBody requires an opened pill or a guarded card row');
    if (name === 'TranscriptPills') {
      calls++;
      if (file !== RENDERER || owner !== 'renderPills' || !jsx ||
          !node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === 'renderBody' && attribute.initializer?.getText(source) === '{renderSystemBody}')) {
        deny(node, 'TranscriptPills must have one call site with the opened system body');
      }
    }
    if (['LedgerSystemLine', 'NotificationLifecycleCard'].includes(name) &&
        (file !== PILLS || owner !== 'TranscriptSystemBody')) deny(node, `${name} must render inside the opened pill`);
    if ((BODY_COMPONENTS.has(name) || ['CornerOpenedMarkers', 'GrantRequestPill'].includes(name)) &&
        (file !== RENDERER || owner !== 'renderSystemBody')) deny(node, `${name} must render inside the opened pill`);
    if (ts.isIdentifier(node) && node.text === 'renderSystemBody' && file === RENDERER &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
      const attribute = ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) ? node.parent.parent : undefined;
      const target = attribute?.parent.parent;
      const pill = owner === 'renderPills' && target && component(target) === 'TranscriptPills';
      if (attribute?.name.getText(source) !== 'renderBody' || !(pill || guardedCardBody(target))) {
        deny(node, 'the system body renderer requires TranscriptPills or a guarded card row');
      }
    }
    const openedBody = (file === RENDERER && owner === 'renderSystemBody') || (file === PILLS && owner === 'TranscriptSystemBody');
    if (!openedBody) {
      // System-specific render branches must go through the pill even when the
      // branch uses generic text, a fragment, or a React element factory.
      const condition = ts.isIfStatement(node) ? node.expression
        : ts.isConditionalExpression(node) ? node.condition
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? node.left : undefined;
      const inlineBody = ts.isJsxExpression(node) && contains(node.expression, noticeSelector);
      if (inlineBody || contains(condition, noticeSelector)) {
        const branches = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement]
          : ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : [node.right];
        const bareBody = child => {
          if (ts.isJsxFragment(child)) return true;
          return (element(child) || factory(child)) && !(buildsOpenedBody && component(child) === 'TranscriptSystemBody');
        };
        if (inlineBody || branches.some(branch => contains(branch, bareBody)))
          deny(node, 'system notice text or elements must render inside the opened pill');
      }
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
