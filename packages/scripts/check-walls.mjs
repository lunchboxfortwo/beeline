import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Checks stay beside their data. This checks refusal construction, not authority. */
export const PATH = [
  { file: 'apps/body/src/agent-runner.ts', functions: ['queueChanged', 'reconcileQueue', 'resendStoredAnswers', 'pump', 'deliver', 'store', 'post'] },
  { file: 'apps/body/src/place-session.ts', functions: ['start', 'startFresh', 'activate', 'deliver', 'hostedModel', 'optional', 'stop', 'dispose'], startup: true },
  { file: 'apps/body/src/read-only-mcp-execute-agent-operation.ts', functions:['executeAgentOperation','executeConversationOperation'] },
  { file: 'apps/body/src/read-only-mcp-open-poll.ts', functions:['executeAgentTool','callAgentTool'] },
  { file: 'apps/body/src/agent-process.ts', functions: ['startAgentProcess', 'stopAgentProcess'], startup: true },
  { file: 'apps/body/src/session-resources.ts', functions: ['refresh', 'load', 'rememberModelCatalog', 'persist'] },
  { file: 'apps/body/src/agent-home.ts', functions: ['prepareRoomAgentCredentials', 'repairRoomAgentCredentialLinks'], startup: true },
  { file: 'apps/server/src/machine-connection.ts', functions: ['machineConnectionOutput', 'serveMachineSocket', 'serveAgentSocket'], transport: true, startup: true },
  { file: 'apps/server/src/daemon-live.ts', functions: ['frame', '#operation', '#readQueue'], transport: true },
  { file: 'apps/server/src/rooms-mcp.ts', functions: ['call','handle','toolResult'], transport:true, protocol:['handle','toolResult'] },
  { file: 'apps/server/src/rooms-mcp-agent.ts', functions: ['call'] },
  { file: 'apps/server/src/phone-socket.ts', functions: ['phoneSocketRequests'], transport: true },
  { file: 'apps/server/src/phone/messages.ts', functions: ['phoneSendMessage'] },
  { file: 'apps/server/src/phone-operations.ts', functions: ['dispatch'] },
  { file: 'apps/server/src/agent-command.ts', functions: ['queueMessage', 'postMessage', 'insertAgentCommand', 'answerQueuedMessage','refuseMessageMembership'] },
  { file: 'apps/server/src/agent-messaging.ts', functions: ['messageAddress','sendMessage','replyToMessage'] },
  { file: 'apps/server/src/agent-command-read-agent-commands.ts', functions: ['readAgentCommands','readAgentQueueRows'] },
  { file: 'apps/server/src/commander.ts', functions: ['sendOrder', 'reportToCommander'] },
  { file: 'apps/server/src/daemon/corner-reports.ts', functions: ['daemonReport'] },
  { file: 'apps/server/src/daemon/corner-messages.ts', functions: ['daemonPostCornerMessage'] },
  { file: 'apps/server/src/daemon/execute.ts', functions: ['daemonExecute'] },
  { file: 'apps/server/src/daemon/messages.ts', functions: ['daemonPostRoomMessage'] },
  { file: 'apps/server/src/corner-worker.ts', functions: ['cornerImplementerSql'] },
];
// Owner-approved product contract. Changing a condition or state requires owner approval.
export const MERGE_CONDITIONS = [
  { condition: 'input.merged', reason: 'the pull request is already merged' },
  { condition: 'input.archived', reason: 'the corner is closed' },
  { condition: "input.checks !== 'passed'", reason: 'checks are ', template: true },
  { condition: '!input.reviewerExists || input.approved', reason: 'no yes on this head', inverted: true },
  { condition: 'input.held', reason: 'a hold stands', template: true },
  { condition: 'input.repositoryMatches === false', reason: 'the merge target no longer matches the linked GitHub repository' },
];
export const THREAD_STATES = ['building', 'checking', 'merged', 'closed', 'working', 'review', 'waiting', 'idle', 'archived'];
export const MERGE_FILES = [
  'apps/server/src/corner-lifecycle.ts',
  'apps/server/src/corner-lifecycle-review-state.ts',
  'apps/server/src/github-operations-read-pr-checks-status.ts',
  'apps/server/src/corner-machine.ts',
  'packages/api-contract/src/daemon-operations-daemon-operation-map.ts',
];

export function judgeMergeContract(root) {
  const errors = [], normalize = text => text.replace(/\s+/g, '').replace(/,([}\]])/g, '$1');
  let gateFound = false, stageFound = false;
  for (const file of MERGE_FILES) {
    const tree = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    errors.push(...tree.parseDiagnostics.map(error => `${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`));
    const checkState = node => {
      if (!node) return;
      if (ts.isStringLiteral(node) && !THREAD_STATES.includes(node.text))
        errors.push(`${file}: thread state ${node.text} is outside the owner-approved states`);
      if (ts.isConditionalExpression(node)) {
        checkState(node.whenTrue); checkState(node.whenFalse);
      } else if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) checkState(node.expression);
      else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
        checkState(node.left); checkState(node.right);
      }
      else if (ts.isParenthesizedTypeNode(node)) checkState(node.type);
      else if (ts.isLiteralTypeNode(node)) checkState(node.literal);
      else if (ts.isUnionTypeNode(node)) node.types.forEach(checkState);
    };
    const visit = node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'cornerMergeability') {
        gateFound = true;
        const returned = node.body?.statements.find(ts.isReturnStatement)?.expression;
        const expectedReturn = "{ mergeAllowed: reasons.length === 0, ...(reasons.length ? { blockedReason: reasons.join('; ') } : {}) }";
        if (node.body?.statements.length !== 2 || !returned || normalize(returned.getText(tree)) !== normalize(expectedReturn))
          errors.push(`${file}: cornerMergeability may refuse only through its six owner-approved conditions`);
        const declaration = node.body?.statements.find(statement => ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some(value => value.name.getText(tree) === 'reasons'));
        const expression = declaration?.declarationList.declarations.find(value => value.name.getText(tree) === 'reasons')?.initializer;
        const array = expression && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
          && expression.expression.name.text === 'filter' && expression.arguments.length === 1
          && expression.arguments[0].getText(tree) === 'Boolean' ? expression.expression.expression : undefined;
        if (!array || !ts.isArrayLiteralExpression(array) || array.elements.length !== MERGE_CONDITIONS.length) {
          errors.push(`${file}: cornerMergeability must contain exactly the six owner-approved merge conditions`);
        } else array.elements.forEach((element, index) => {
          const rule = MERGE_CONDITIONS[index];
          if (!ts.isConditionalExpression(element) || normalize(element.condition.getText(tree)) !== normalize(rule.condition)) {
            errors.push(`${file}: merge condition ${index + 1} differs from the owner-approved list`);
            return;
          }
          const reason = rule.inverted ? element.whenFalse : element.whenTrue;
          const empty = rule.inverted ? element.whenTrue : element.whenFalse;
          const validReason = rule.template
            ? ts.isTemplateExpression(reason) && reason.head.text === rule.reason
            : ts.isStringLiteral(reason) && reason.text === rule.reason;
          if (!validReason || !ts.isStringLiteral(empty) || empty.text !== '')
            errors.push(`${file}: merge refusal ${index + 1} differs from the owner-approved list`);
        });
      }
      if ((ts.isVariableDeclaration(node) && node.name.getText(tree) === 'stage') ||
          ((ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) &&
            ['stage', 'state'].includes(node.name.getText(tree)))) {
        if (node.name.getText(tree) === 'stage') stageFound = true;
        checkState(ts.isPropertySignature(node) ? node.type : node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  if (!gateFound || !stageFound) errors.push('merge gate and stage computation must remain watched by check-walls');
  return errors;
}
// Owner-approved destinations: messages use their tuple, replies use the recorded
// sender tuple, repairs use the implementer, review uses the reviewer, and System
// work replies to the thread commander. No last-tag or ancestor destination exists.
export const WAKE_DESTINATIONS = {
  'merge-conflict': 'corner.worker_agent_id',
  revision: 'agentId',
  'checks-failed': 'corner.worker_agent_id',
  review: 'reviewer',
  'review-findings': 'corner.worker_agent_id',
  'merge-refused': 'corner.worker_agent_id',
};
export const MESSAGE_WAKE_DESTINATIONS = {
  message: { agent: 'to.agent', place: 'to.place' },
  reply: { agent: 'route.from.agent', place: 'route.from.place' },
  system: 'chat.commander',
  idleNotice: 'senderTask ? (await recordedMessageRoute(db,senderTask)).from : undefined',
};
export function judgeWakeDestinations(root) {
  const errors=[], normalize=text=>text.replace(/\s+/g,'');
  const file='apps/server/src/corner-lifecycle.ts';
  const tree=ts.createSourceFile(file,readFileSync(resolve(root,file),'utf8'),ts.ScriptTarget.Latest,true);
  const found=new Set();
  const visit=node=>{
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text in WAKE_DESTINATIONS) {
      const effect=node.expression.text;
      const calls=child=>{
        if(ts.isCallExpression(child) && ['createAgentCommand','queueReviewerCommand'].includes(child.expression.getText(tree))) {
          const destination=child.arguments[1];
          const agent=destination && ts.isObjectLiteralExpression(destination) && destination.properties.find(property=>property.name?.getText(tree)==='agentId');
          const value=agent && (ts.isPropertyAssignment(agent)?agent.initializer.getText(tree):agent.name.getText(tree));
          if(value!==WAKE_DESTINATIONS[effect]) errors.push(`${file}: ${effect} must wake ${WAKE_DESTINATIONS[effect]}`);
          found.add(effect);
        }
        ts.forEachChild(child,calls);
      };
      node.statements.forEach(calls);
    }
    ts.forEachChild(node,visit);
  };
  visit(tree);
  for(const effect of Object.keys(WAKE_DESTINATIONS)) if(!found.has(effect)) errors.push(`${file}: missing fixed ${effect} destination`);
  for(const [name,expected] of [['agentId','corner.worker_agent_id !== event.command.agent_id ? corner.worker_agent_id : null'],['reviewer','reachableReviewer(corner)']]) {
    const declaration=[];
    const find=node=>{if(ts.isVariableDeclaration(node) && node.name.getText(tree)===name && node.initializer) declaration.push(normalize(node.initializer.getText(tree)));ts.forEachChild(node,find);};
    find(tree);
    if(!declaration.includes(normalize(expected))) errors.push(`${file}: ${name} must retain its fixed thread role`);
  }
  const messaging=readFileSync(resolve(root,'apps/server/src/agent-messaging.ts'),'utf8');
  if(!normalize(messaging).includes(normalize('roomId: to.place, agentId: to.agent')))
    errors.push('message delivery must wake its agent and place tuple');
  const queue=readFileSync(resolve(root,'apps/server/src/agent-command.ts'),'utf8');
  if(!normalize(queue).includes(normalize('to:route.from')) || !normalize(queue).includes(normalize('replyAddress:chat.commander')))
    errors.push('reply and System destinations must retain the recorded sender and thread commander');
  const notices=readFileSync(resolve(root,'apps/server/src/commander.ts'),'utf8');
  if(!normalize(notices).includes(normalize(`const replyAddress=${MESSAGE_WAKE_DESTINATIONS.idleNotice};`)) ||
      !normalize(notices).includes(normalize('route.incoming?.parent_command_id ?? route.parent?.id')) ||
      !normalize(notices).includes(normalize('replyAddress,automatic:true')))
    errors.push('idle notices must freeze the direct parent task sender and retain System when there is no parent');
  return errors;
}
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
  return { sites, walls, missing: functions.filter(name => !found.has(name)).map(name => `${file}: path function ${name} is missing; update packages/scripts/check-walls.mjs`) };
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
  const errors = [...judgeMergeContract(root),...judgeWakeDestinations(root)], kinds = wallKinds(root);
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
  const errors = judgeWalls(resolve(fileURLToPath(new URL('../..', import.meta.url))));
  errors.forEach(error => console.error(error));
  if (errors.length) { console.error(`Walls check failed: ${errors.length} problem(s).`); process.exitCode = 1; }
  else console.log(`Walls check passed (${PATH.length} path files).`);
}
