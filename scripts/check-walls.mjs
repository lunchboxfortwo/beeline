import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * The functions on the request -> agent -> answer path: where a request is
 * put in an agent's queue, handed to its session, and where the answer is
 * posted. Every place in them that can refuse, drop, skip or hold a request
 * must be one of the walls in docs/walls.md, listed there by its text.
 */
export const PATH = [
  { file: 'apps/body/src/agent-runner.ts', functions: ['queueChanged', 'reconcileQueue', 'resendStoredAnswers', 'pump', 'deliver', 'store', 'post'] },
  { file: 'apps/server/src/agent-command-create-agent-command.ts', functions: ['routeHumanMessage'] },
  { file: 'apps/server/src/agent-command.ts', functions: ['insertAgentCommand'] },
  { file: 'apps/server/src/agent-command-read-agent-commands.ts', functions: ['readAgentCommands'] },
  { file: 'apps/server/src/agent-command-route-agent-result.ts', functions: ['authorizeCommandOutput'] },
  { file: 'apps/server/src/daemon/execute.ts', functions: ['daemonExecute'] },
  { file: 'apps/server/src/daemon/messages.ts', functions: ['daemonPostRoomMessage'] },
];

export const WALLS_FILE = 'docs/walls.md';
export const WALL_IDS = ['signed-in', 'membership', 'credentials', 'sandbox', 'stop'];

const CAP = /lease|capacity|quota|admission|admit|budget|throttle|ratelimit|maxattempts|retries|retrycount|maxretr/i;
const WAITS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'sleep', 'delay']);

function collapse(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  return undefined;
}

/** Stop sites inside the named functions of one file. */
export function stopSites(file, text, functions) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites = [];
  const found = new Set();
  const isFinal = (statement) => {
    const block = statement.parent;
    return ts.isBlock(block) && ts.isFunctionLike(block.parent) && block.statements.at(-1) === statement;
  };
  /** A stop is named by its guard, so two bare `return;` lines stay distinct. */
  const guard = (node) => {
    for (let at = node.parent; at && !ts.isFunctionLike(at); at = at.parent)
      if (ts.isIfStatement(at)) return `if (${at.expression.getText(tree)}) `;
    return '';
  };
  const scan = (name, node) => {
    const add = (kind, at) => sites.push(`${file} ${name}: ${kind} ${collapse(`${guard(at)}${at.getText(tree)}`)}`);
    if (ts.isThrowStatement(node)) add('refuse', node);
    else if (ts.isReturnStatement(node) && !isFinal(node) &&
        (!node.expression || ['undefined', 'null', 'false'].includes(node.expression.getText(tree)))) add('early return', node);
    else if (ts.isContinueStatement(node) || ts.isBreakStatement(node)) add('skip', node);
    else if (ts.isCallExpression(node) && WAITS.has(node.expression.getText(tree).split('.').at(-1))) add('wait', node);
    else if (ts.isNewExpression(node) && node.expression.getText(tree) === 'Promise') add('wait', node);
    else if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && CAP.test(node.text)) add('cap', node.parent);
    ts.forEachChild(node, child => scan(name, child));
  };
  const visit = (node) => {
    const name = functionName(node);
    if (name && functions.includes(name)) {
      found.add(name);
      const body = ts.isVariableDeclaration(node) ? node.initializer.body : node.body;
      if (body) ts.forEachChild(body, child => scan(name, child));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const missing = functions.filter(name => !found.has(name)).map(name => `${file}: path function ${name} is missing; update scripts/check-walls.mjs`);
  return { sites, missing };
}

/** The listed sites per wall, read from docs/walls.md. */
export function listedWalls(text) {
  const walls = new Map();
  let current;
  for (const line of text.split('\n')) {
    const heading = /^## `([a-z-]+)`/.exec(line);
    if (heading) { current = heading[1]; walls.set(current, []); continue; }
    const site = /^- `(.+)`$/.exec(line);
    if (site && current) walls.get(current).push(site[1].replaceAll('\\`', '`'));
  }
  return walls;
}

export function judgeWalls(root) {
  const errors = [];
  const walls = listedWalls(readFileSync(resolve(root, WALLS_FILE), 'utf8'));
  const ids = [...walls.keys()];
  if (ids.join() !== WALL_IDS.join())
    errors.push(`${WALLS_FILE} must list exactly these walls, in order: ${WALL_IDS.join(', ')} (found ${ids.join(', ') || 'none'})`);
  const listed = new Set([...walls.values()].flat());
  const present = new Set();
  for (const { file, functions } of PATH) {
    const { sites, missing } = stopSites(file, readFileSync(resolve(root, file), 'utf8'), functions);
    errors.push(...missing);
    for (const site of sites) {
      present.add(site);
      if (!listed.has(site))
        errors.push(`not a wall: ${site}\n  Nothing on the request -> agent -> answer path may refuse, drop, skip or hold a request except the walls in ${WALLS_FILE}.`);
    }
  }
  for (const site of listed)
    if (!present.has(site)) errors.push(`${WALLS_FILE} lists a site that is not in the code: ${site}`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const errors = judgeWalls(root);
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`Walls check failed: ${errors.length} problem(s). A new wall needs lunchboxfortwo's review of ${WALLS_FILE}.`);
    process.exitCode = 1;
  } else console.log(`Walls check passed (${PATH.length} path files).`);
}
