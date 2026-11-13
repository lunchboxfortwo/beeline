import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PATH, WALLS_FILE, WALL_BUILDER_FILE, judgeWalls } from './check-walls.mjs';
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
test('only the shared builder and its known kinds may construct a refusal', () => {
  const target = copy();
  try {
    const path = resolve(target, 'apps/body/src/agent-runner.ts');
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, "import { wall } from '@beeline/api-contract/daemon';\n" + text.replace('place.running = item;', "place.running = item;\nthrow wall('membership', 'only chat members');"));
    assert.deepEqual(judgeWalls(target), []);
    plant(target, 'apps/body/src/agent-runner.ts', "wall('membership',", "wall('quota',");
    assert.ok(judgeWalls(target).some(error => error.includes('unknown wall kind')));
    writeFileSync(path, 'const wall = () => new Error();\n' + text.replace('place.running = item;', "place.running = item;\nthrow wall('membership', 'pretend');"));
    assert.ok(judgeWalls(target).some(error => error.includes('shared builder')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

mutation('a new machine registration cap fails', 'apps/server/src/machine-connection.ts',
  '    const token = item.token;', '    const token = item.token;\nif (sessions.size > 64) return;');
mutation('a machine output drop fails', 'apps/server/src/machine-connection.ts',
  '    const open = client.readyState === client.OPEN;', '    if (client.bufferedAmount > 1000) return false;\n    const open = client.readyState === client.OPEN;');
mutation('a daemon frame admission gate fails', 'apps/server/src/daemon-live.ts',
  '    if (this.#closed) return;\n    if ([', '    if (raw.admissionDenied) return;\n    if (this.#closed) return;\n    if ([');

mutation('a syntax error cannot hide a path guard', 'apps/body/src/agent-runner.ts', 'place.running = item;', 'place.running = item; if (');
