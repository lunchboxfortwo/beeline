import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PATH, WALLS_FILE, WALL_BUILDER_FILE, judgeWalls, productionWallSites } from './check-walls.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function copy() {
  const target = mkdtempSync(resolve(tmpdir(), 'walls-'));
  for (const file of [WALLS_FILE, WALL_BUILDER_FILE, ...PATH.map(entry => entry.file)])
    cpSync(resolve(root, file), resolve(target, file), { recursive: true });
  return target;
}
function plant(target, file, find, replace) {
  const path = resolve(target, file), text = readFileSync(path, 'utf8');
  assert.ok(text.includes(find), `planting point missing: ${file}`);
  writeFileSync(path, text.replace(find, replace));
}
function mutation(name, file, find, code) {
  test(name, () => {
    const target = copy();
    try {
      plant(target, file, find, code);
      assert.ok(judgeWalls(target).length, 'the planted gate passed');
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
}
test('the tree passes without a per-line exception list', () => assert.deepEqual(judgeWalls(root), []));
for (const [name, code] of [
  ['refusal', "if (item.reason === 'schedule') throw new Error('paused');"],
  ['aliased refusal', "const denied = new Error('paused'); throw denied;"],
  ['rejected answer', "return Promise.reject(new Error('not now'));"],
  ['negative return', 'if (item.agentDepth > 2) return { delivered: false };'],
  ['skip receipt', 'if (item.agentDepth > 2) return { skipped: true };'],
  ['provider wait', 'await this.github.refreshCornerReviewHead(item.roomId);'],
  ['early return', 'if (item.agentDepth > 2) return;'],
  ['wait', 'await new Promise(done => setTimeout(done, 1000));'],
  ['cap', 'if (this.places.size > this.admissionLimit) place.waiting.push(item);'],
  ['legacy refusal helper', "if (item.reason === 'schedule') refuse(403, 'paused');"],
]) mutation(`a new ${name} fails`, 'apps/body/src/agent-runner.ts', 'place.running = item;', `place.running = item;\n${code}`);
for (const [name, code] of [
  ['refusal', "throw new Error('startup refused');"],
  ['optional read', "await api.execute('getAgentConfiguration', { agentId: agent.publicKey });"],
  ['dependency', 'await installNewDependency();'],
  ['composed dependency', 'await Promise.all([installNewDependency()]);'],
  ['optional dependency', "await this.optional('setup', () => installNewDependency(), undefined);"],
]) mutation(`a startup ${name} fails`, 'apps/body/src/place-session.ts', '    const corner = Boolean(parentRoomId);', `${code}\n    const corner = Boolean(parentRoomId);`);
mutation('a dependency in credential preparation fails', 'apps/body/src/agent-home.ts',
  '  const root = resolve(input.root);', '  await installNewDependency();\n  const root = resolve(input.root);');
mutation('a renamed path function fails', 'apps/body/src/agent-runner.ts', 'private async post(', 'private async publish(');
mutation('a per-line exception cannot bless a refusal', WALLS_FILE, '## `stop` Stop',
  '## `stop` Stop\n\n- `apps/body/src/agent-runner.ts deliver: refuse new Error()`');
mutation('a new builder kind requires matching documentation', WALL_BUILDER_FILE, "'sandbox', 'stop'", "'sandbox', 'stop', 'quota'");
mutation('a documented kind cannot be added without the builder', WALLS_FILE, '## `stop` Stop', '## `quota` Quota\n\nWhy: no.\n\n## `stop` Stop');
test('only the shared builder and its known kinds may construct an existing wall', () => {
  const target=copy();
  try {
    plant(target,'apps/server/src/agent-command.ts',"wall('membership',","wall('stop',");
    assert.deepEqual(judgeWalls(target),[]);
    plant(target,'apps/server/src/agent-command.ts',"wall('stop',","wall('quota',");
    assert.ok(judgeWalls(target).some(error=>error.includes('unknown wall kind')));
    const file=resolve(target,'apps/server/src/phone-socket.ts');
    writeFileSync(file,readFileSync(file,'utf8').replace(/import \{[^}]*\bwall\b[^}]*\} from '@beeline\/api-contract\/daemon';/, 'const wall = () => new Error();'));
    assert.ok(judgeWalls(target).some(error=>error.includes('shared builder')));
  } finally {rmSync(target,{recursive:true,force:true});}
});

test('a fifth canonical construction requires changing the captain-owned wall document', () => {
  const target=copy();
  try {
    const file=resolve(target,'apps/body/src/place-session.ts');
    writeFileSync(file,"import {wall} from '@beeline/api-contract/daemon';\n"+readFileSync(file,'utf8').replace('  async start(item?: AgentCommand): Promise<void> {',"  async start(item?: AgentCommand): Promise<void> { if(this.stale) throw wall('stop','added refusal');"));
    assert.equal(productionWallSites(target).length,5);
    assert.ok(judgeWalls(target).some(error=>error.includes('maximum 4')));
    plant(target,WALLS_FILE,'Production wall constructions: 4.','Production wall constructions: 5.');
    assert.deepEqual(judgeWalls(target),[]);
  } finally {rmSync(target,{recursive:true,force:true});}
});

mutation('a new machine registration cap fails', 'apps/server/src/machine-connection.ts',
  '    const token = item.token;', '    const token = item.token;\nif (sessions.size > 64) return;');
mutation('a machine output drop fails', 'apps/server/src/machine-connection.ts',
  '    const open = client.readyState === client.OPEN;', '    if (client.bufferedAmount > 1000) return false;\n    const open = client.readyState === client.OPEN;');
mutation('a daemon frame admission gate fails', 'apps/server/src/daemon-live.ts',
  '    if (this.#closed) return;\n    if ([', '    if (raw.admissionDenied) return;\n    if (this.#closed) return;\n    if ([');

mutation('a syntax error cannot hide a path guard', 'apps/body/src/agent-runner.ts', 'place.running = item;', 'place.running = item; if (');

test('a fifth production wall construction fails even outside the named request path', () => {
  const target = copy();
  try {
    const file = resolve(target, 'apps/server/src/wall-sprawl.ts');
    writeFileSync(file, "import {wall} from '@beeline/api-contract/daemon';\n" +
      Array.from({length: 1}, (_, i) => `export const refusal${i} = () => wall('membership', 'duplicate');`).join('\n'));
    assert.ok(productionWallSites(target).length > 4);
    assert.ok(judgeWalls(target).some(error => error.includes('maximum 4')));
  } finally { rmSync(target, {recursive:true, force:true}); }
});

mutation('an MCP message budget fails', 'apps/server/src/rooms-mcp.ts',
  '    let input: Record<string, unknown>;', '    await this.oauth.take(principal);\n    let input: Record<string, unknown>;');
mutation('an MCP message body cap fails', 'apps/server/src/rooms-mcp.ts',
  'mcpBody(request, null)', 'mcpBody(request, 320000)');
mutation('an MCP audit wait fails', 'apps/server/src/rooms-mcp.ts',
  "void this.audit(principal, name, 'succeeded');", "await this.audit(principal, name, 'succeeded');");
