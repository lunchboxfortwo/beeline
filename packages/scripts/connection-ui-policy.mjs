import ts from 'typescript';
import { uiSourceFiles } from './mobile-ui-policy.mjs';

export const CONNECTION_BANNER = 'components/buzz/ConnectionStatus.tsx';
// Domain failures (provider/model choices, local files/storage and GitHub)
// are not claims about the phone's connection to Beeline.
const domainFailure = /GitHub|(?:load|refresh) repos(?:itories)?\b|(?:load|open) (?:effort|model|these) choices|load pinned conversations|read file/i;
const connectivityCopy = /(?:could(?:n['’]t| not)|unable to|failed to)\s+(?:load|fetch|read|refresh|search)\b|\b(?:network|connection|Beeline(?! identity))\b.{0,45}\b(?:unavailable|offline|disconnected|not (?:available|connected)|lost|failed)\b|\b(?:could|can)(?: not|n['’]t) be (?:loaded|fetched|read)\b|\b(?:(?:Rooms?|Corner) (?:details|list)|Activity|Output|History|Helpers|Workflows?) (?:is |are )?unavailable\b|(?:could(?:n['’]t| not)|unable to)\s+connect\s+(?:to\s+)?(?:Beeline|server|Room)\b/i;
const retryCopy = /^(?:retry|try again|reconnect)$/i;
const mutation = /\b(?:outbox|revoke|stop|send|join|handleReconnectRoomRepository|reconnectApp|retryInstall|recover|onReset|onRetryAttachment|retryPairing)\b|voice|retrySend/i;
const failureCondition = /error|fail(?:ed|ure)?|unavailable|offline/i;

/** Zero allowance: no registry budget or per-screen exemption can admit this UI. */
export function scanConnectionUi(source, file) {
  if (file === CONNECTION_BANNER) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const errors = [];
  function report(node, message) {
    errors.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      rule: 'single-connection-banner', message });
  }
  function text(node) {
    if (!node) return '';
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) return node.text;
    if (ts.isJsxExpression(node)) return text(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return text(node.left) + text(node.right);
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => ' ' + span.literal.text).join('');
    return node.getText(ast);
  }
  function conditions(node) {
    const result = [];
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isConditionalExpression(p) && node.pos >= p.whenTrue.pos && node.end <= p.whenTrue.end) result.push(p.condition.getText(ast));
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) result.push(p.left.getText(ast));
      if (ts.isIfStatement(p)) result.push(p.expression.getText(ast));
    }
    return result.join(' ');
  }
  function diagnostic(node) {
    for (let p = node.parent; p && !ts.isStatement(p); p = p.parent) {
      if (ts.isCallExpression(p) && /(?:console\.|\blog|markRoomOpen)/.test(p.expression.getText(ast))) return true;
    }
    return false;
  }
  function domainContext(node) {
    for (let p = node.parent; p; p = p.parent) {
      if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName.getText(ast) === 'AgentApprovalCard' && /^Connection failed\. Retry to continue\.$/.test(text(node))) return true;
      if (file.endsWith('.mock.ts') && ts.isPropertyAssignment(p) && p.name.getText(ast) === 'output') return true;
    }
    return false;
  }
  function inspectRetry(node, tag, attrs, childText = '') {
    const attr = name => attrs.find(value => value.name?.getText(ast).replace(/^['"]|['"]$/g, '') === name);
    const value = name => text(attr(name)?.initializer);
    const callback = value('onRetry') || value('onPress');
    const hasRetry = Boolean(attr('onRetry') && value('onRetry') !== 'undefined') || retryCopy.test(childText.trim()) ||
      ['action', 'label', 'title', 'accessibilityLabel'].some(name => retryCopy.test(value(name).replace(/^['"]|['"]$/g, '')) || /retryLabel/.test(value(name)));
    // Shared controls forward callbacks; they cannot introduce failure copy.
    const forwarding = file === 'components/buzz/ErrorBanner.tsx';
    // The root error screen retries a render crash, not a connection.
    const domain = value('testID') === 'runtime-error-retry' || /RoomMessageCell|OrdinaryLedgerMessage|SendFailure|Voice/.test(tag) ||
      domainFailure.test(node.getText(ast)) || /Secure storage unavailable|Could not stop this/.test(node.getText(ast));
    if (hasRetry && !forwarding && !domain && !mutation.test(callback) &&
      (attr('onRetry') || failureCondition.test(conditions(node)) || /retry|read|load|refresh/i.test(callback)))
      report(node, 'A failed read cannot render its own Retry affordance. ConnectionStatus is the only connection recovery UI.');
  }
  function walk(node) {
    if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) &&
      /\s/.test(text(node)) && connectivityCopy.test(text(node)) && !domainFailure.test(text(node)) && !diagnostic(node) && !domainContext(node)) {
      report(node, 'Connectivity/load-failure copy belongs only to ConnectionStatus. Failed socket reads use its single reconnect; keep cached content visible.');
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      inspectRetry(node, node.tagName.getText(ast), node.attributes.properties);
    if (ts.isCallExpression(node) && /^(?:React\.)?createElement$/.test(node.expression.getText(ast)) && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1]))
      inspectRetry(node, node.arguments[0].getText(ast), node.arguments[1].properties, text(node.arguments[2]));
    if (ts.isJsxText(node) && retryCopy.test(node.text.trim())) {
      const parent = node.parent;
      if (ts.isJsxElement(parent) && /error|fail|unavailable/i.test(conditions(parent)) &&
          parent.openingElement.attributes.properties.some(attr => attr.name?.text === 'onPress'))
        report(node, 'A failed read cannot render its own Retry affordance. ConnectionStatus is the only connection recovery UI.');
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return errors;
}
export function checkConnectionUiTree(root) {
  return uiSourceFiles(root).flatMap(({ source, file }) => scanConnectionUi(source, file));
}
