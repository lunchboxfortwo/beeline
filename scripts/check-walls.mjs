import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Checks stay beside their data. This checks refusal construction, not authority. */
export const PATH = [
  { file: 'apps/body/src/agent-runner.ts', functions: ['queueChanged', 'reconcileQueue', 'resendStoredAnswers', 'pump', 'deliver', 'store', 'post'] },
  { file: 'apps/body/src/place-session.ts', functions: ['start', 'startFresh', 'activate', 'deliver', 'followUp', 'hostedModel', 'optional', 'stop', 'dispose'], startup: true },
  { file: 'apps/body/src/read-only-mcp-execute-agent-operation.ts', functions:['executeAgentOperation','executeConversationOperation'] },
  { file: 'apps/body/src/read-only-mcp-open-poll.ts', functions:['executeAgentTool','callAgentTool'] },
  { file: 'apps/body/src/agent-process.ts', functions: ['startAgentProcess', 'stopAgentProcess'], startup: true },
  { file: 'apps/body/src/session-resources.ts', functions: ['refresh', 'load', 'rememberModelCatalog', 'persist'] },
  { file: 'apps/body/src/agent-home.ts', functions: ['prepareRoomAgentCredentials', 'repairRoomAgentCredentialLinks'], startup: true },
  { file: 'apps/server/src/machine-connection.ts', functions: ['machineConnectionOutput', 'serveMachineSocket', 'serveAgentSocket'], transport: true, startup: true },
  { file: 'apps/server/src/daemon-live.ts', functions: ['frame', '#operation', '#readQueue'], transport: true },
  { file: 'apps/server/src/rooms-mcp.ts', functions: ['call','sendMessage','handle','toolResult'], transport:true, protocol:['handle','toolResult'] },
  { file: 'apps/server/src/rooms-mcp-agent.ts', functions: ['call'] },
  { file: 'apps/server/src/phone-socket.ts', functions: ['phoneSocketRequests'], transport: true },
  { file: 'apps/server/src/phone/messages.ts', functions: ['phoneSendMessage'] },
  { file: 'apps/server/src/phone-operations.ts', functions: ['dispatch'] },
  { file: 'apps/server/src/agent-command.ts', functions: ['queueMessage', 'postMessage', 'insertAgentCommand', 'answerQueuedMessage'] },
  { file: 'apps/server/src/agent-command-read-agent-commands.ts', functions: ['readAgentCommands','readAgentQueueRows'] },
  { file: 'apps/server/src/commander.ts', functions: ['sendOrder', 'reportToCommander'] },
  { file: 'apps/server/src/daemon/corner-reports.ts', functions: ['daemonReport'] },
  { file: 'apps/server/src/daemon/corner-messages.ts', functions: ['daemonPostCornerMessage'] },
  { file: 'apps/server/src/daemon/execute.ts', functions: ['daemonExecute'] },
  { file: 'apps/server/src/daemon/messages.ts', functions: ['daemonPostRoomMessage'] },
];
export const WALLS_FILE = 'docs/walls.md';
export const WALL_BUILDER_FILE = 'packages/api-contract/src/walls.ts';
const CAP = /(?<!re)lease|capacity|quota|admission|admit|budget|throttle|ratelimit|maxattempts|retries|retrycount|maxretr/i;
const WAITS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'sleep', 'delay']);
// These are the protocol handoff and private credential/sandbox bootstrap,
// not additional admission waits. New optional dependencies are rejected.
const SESSION_OPERATIONS = new Set(['this.repairCredentialLinks', 'this.startFresh', 'this.stop', 'this.activate',
  'mkdir', 'mkdtemp', 'provisionRoomAgentCredentials', 'prepareRoomAgentCredentials', 'installPiMcpBridge', 'startAgentProcess', 'stopAgentProcess',
  'openAcpConversation', 'applyAgentModelSelection', 'answering', 'client.startProcess', 'client.stopProcess',
  'repairRoomAgentCredentialLinks', 'lstat', 'assertRealContainedDirectory', 'writeIsolatedHarnessFile',
  'readlink', 'rm', 'symlink', 'rename', 'writeBackDetachedClaudeLogin', 'readFile', 'provisionPiCustomModelConfig',
  'deps.auth.authenticateDaemon', 'deps.auth.retiredDaemonAgent', 'session.claim', 'read', 'this.hostedModel', 'this.writeContext', 'OwnedModelFiles.create', 'readOnlyMcpServer', 'beelineAgentMcpServer', 'installOwnedModelProvider']);

export function wallKinds(root) {
  const source = ts.createSourceFile(WALL_BUILDER_FILE, readFileSync(resolve(root, WALL_BUILDER_FILE), 'utf8'), ts.ScriptTarget.Latest, true);
  let kinds = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'WALL_KINDS') {
      let value = node.initializer;
      if (ts.isAsExpression(value)) value = value.expression;
      if (ts.isArrayLiteralExpression(value)) kinds = value.elements.filter(ts.isStringLiteral).map(value => value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return kinds;
}

function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
}

export function stopSites(file, text, functions, startup = false, kinds = [], transport = false, protocol = []) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites = tree.parseDiagnostics.map(error => `${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`), walls = [], found = new Set();
  const imported = tree.statements.some(node => ts.isImportDeclaration(node) &&
    node.moduleSpecifier.text === '@beeline/api-contract/daemon' &&
    node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some(element => element.name.text === 'wall' && (!element.propertyName || element.propertyName.text === 'wall')));
  const isWall = node => ts.isCallExpression(node) && node.expression.getText(tree) === 'wall';
  const guard = node => {
    for (let at = node.parent; at && !ts.isFunctionLike(at); at = at.parent)
      if (ts.isIfStatement(at)) return `if (${at.expression.getText(tree)}) `;
    return '';
  };
  const awaited = expression => {
    while (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        ['catch', 'then', 'finally'].includes(expression.expression.name.text)) expression = expression.expression.expression;
    if (!ts.isCallExpression(expression)) return SESSION_OPERATIONS.has(expression.getText(tree));
    const callee = expression.expression.getText(tree);
    if (callee === 'Promise.all' || callee === 'this.optional') {
      const nested = callee === 'this.optional' ? expression.arguments[1] : expression.arguments[0];
      const inspect = node => {
        if (ts.isArrayLiteralExpression(node)) return node.elements.every(inspect);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return ts.isBlock(node.body)
          ? node.body.statements.every(statement => !ts.isReturnStatement(statement) || !statement.expression || inspect(statement.expression))
          : inspect(node.body);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') return node.arguments.every(inspect);
        return awaited(node);
      };
      return Boolean(nested && inspect(nested));
    }
    // The current item's hosted credential is necessary to use its own model.
    if (callee.endsWith('.execute') && expression.arguments[0]?.text === 'getModelCredential') return true;
    return SESSION_OPERATIONS.has(callee);
  };
  const propagated = expression => {
    if (!ts.isIdentifier(expression)) return false;
    for (let at = expression.parent; at; at = at.parent) {
      if (ts.isCatchClause(at) && at.variableDeclaration?.name.getText(tree) === expression.text) return true;
      if (ts.isFunctionLike(at)) {
        const call = at.parent;
        return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === 'catch' && at.parameters.some(parameter => parameter.name.getText(tree) === expression.text);
      }
    }
    return false;
  };
  const scan = (name, node) => {
    const add = kind => sites.push(`${file} ${name}: ${kind} ${`${guard(node)}${node.getText(tree)}`.replace(/\s+/g, ' ').trim()}`);
    if (isWall(node)) {
      const kind = node.arguments[0];
      if (!imported) add('wall must use the shared builder');
      if (!kind || !ts.isStringLiteral(kind) || !kinds.includes(kind.text)) add('unknown wall kind');
      else walls.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, kind: kind.text, reason: node.arguments[1]?.getText(tree) });
    }
    if (!protocol.includes(name) && ts.isThrowStatement(node) && !isWall(node.expression) && !propagated(node.expression)) add('refuse without wall');
    else if (ts.isCallExpression(node) && node.expression.getText(tree) === 'refuse') add('refuse without wall');
    else if (ts.isCallExpression(node) && node.expression.getText(tree) === 'Promise.reject' && !isWall(node.arguments[0])) add('reject without wall');
    else if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression) && node.expression.properties.some(property => ts.isPropertyAssignment(property) && ((['delivered', 'accepted', 'allowed'].includes(property.name.getText(tree)) && property.initializer.kind === ts.SyntaxKind.FalseKeyword) || (property.name.getText(tree) === 'skipped' && property.initializer.kind === ts.SyntaxKind.TrueKeyword)))) add('negative return');
    else if (!protocol.includes(name) && ts.isReturnStatement(node) && ((!node.expression && !transport) || node.expression && ['undefined', 'null', 'false'].includes(node.expression.getText(tree)))) add('early return');
    else if (ts.isContinueStatement(node) || ts.isBreakStatement(node)) add('skip');
    else if (transport && ts.isCallExpression(node) && node.expression.getText(tree)==='mcpBody' && node.arguments[1]?.kind!==ts.SyntaxKind.NullKeyword) add('message body cap');
    else if (transport && ts.isCallExpression(node) && /\.(?:take|acquire|reserve)$/.test(node.expression.getText(tree))) add('admission');
    else if (transport && ts.isAwaitExpression(node) && /\.audit$/.test(node.expression.expression?.getText(tree) ?? '')) add('optional audit wait');
    else if (startup && ts.isAwaitExpression(node) && !awaited(node.expression)) add('wait');
    else if (startup && ts.isCallExpression(node) && /(?:^|\.)execute$/.test(node.expression.getText(tree)) && node.arguments[0]?.text !== 'getModelCredential') add('optional setup read');
    else if (ts.isAwaitExpression(node) && /(?:refreshCornerReviewHead|refreshToken|installDependencies|gitClone|prepareWorkspace)/.test(node.expression.getText(tree))) add('optional setup wait');
    else if (ts.isCallExpression(node) && WAITS.has(node.expression.getText(tree).split('.').at(-1))) add('wait');
    else if (ts.isNewExpression(node) && node.expression.getText(tree) === 'Promise') add('wait');
    else if (transport && ts.isBinaryExpression(node) && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(node.operatorToken.kind) && /(?:\.size|\.length|\.bufferedAmount)/.test(node.left.getText(tree))) add('cap');
    else if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && CAP.test(node.text)) add('cap');
    ts.forEachChild(node, child => scan(name, child));
  };
  const visit = node => {
    const name = functionName(node);
    if (name && functions.includes(name)) {
      found.add(name);
      const body = ts.isVariableDeclaration(node) ? node.initializer.body : node.body;
      if (body) ts.forEachChild(body, child => scan(name, child));
    } else ts.forEachChild(node, visit);
  };
  visit(tree);
  return { sites, walls, missing: functions.filter(name => !found.has(name)).map(name => `${file}: path function ${name} is missing; update scripts/check-walls.mjs`) };
}

/** Count every production construction, including files outside the route inventory. */
export function productionWallSites(root) {
  const sites = [];
  const walk = folder => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', 'build', '__tests__', 'fixtures'].includes(entry.name)) walk(file);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = node => {
          if (ts.isCallExpression(node) && node.expression.getText(tree) === 'wall')
            sites.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
    }
  };
  walk(resolve(root, 'apps')); walk(resolve(root, 'packages'));
  return sites;
}

export function judgeWalls(root) {
  const errors = [], kinds = wallKinds(root);
  const constructions = productionWallSites(root);
  const docs = readFileSync(resolve(root, WALLS_FILE), 'utf8');
  const maximum = Number(docs.match(/^Production wall constructions: (\d+)\.$/m)?.[1]);
  if (!Number.isInteger(maximum) || constructions.length > maximum) errors.push(`Production wall sites: ${constructions.length}; maximum ${maximum} from ${WALLS_FILE}. Additions require captain review there.\n${constructions.join('\n')}`);
  const documented = [...docs.matchAll(/^## `([a-z-]+)`/gm)].map(match => match[1]);
  if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.join() !== documented.join())
    errors.push(`${WALLS_FILE} must list exactly the kinds in ${WALL_BUILDER_FILE}: ${kinds.join(', ')}`);
  if (/^- `apps\//m.test(docs)) errors.push(`${WALLS_FILE} lists kinds and why, never per-line exceptions`);
  for (const { file, functions, startup, transport, protocol } of PATH) {
    const { sites, missing } = stopSites(file, readFileSync(resolve(root, file), 'utf8'), functions, startup, kinds, transport, protocol);
    errors.push(...missing, ...sites.map(site => `not a wall: ${site}\n  Refusals must use wall(kind, reason); no other gate, cap, skip or wait may stop an answer.`));
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = judgeWalls(resolve(fileURLToPath(new URL('..', import.meta.url))));
  errors.forEach(error => console.error(error));
  if (errors.length) { console.error(`Walls check failed: ${errors.length} problem(s).`); process.exitCode = 1; }
  else console.log(`Walls check passed (${PATH.length} path files).`);
}
