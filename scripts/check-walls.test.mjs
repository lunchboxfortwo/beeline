import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PATH, WALLS_FILE, judgeWalls } from './check-walls.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A copy of the path files and walls list, so a planted change never touches the tree. */
function copy() {
  const target = mkdtempSync(resolve(tmpdir(), 'walls-'));
  for (const file of [WALLS_FILE, ...PATH.map(entry => entry.file)])
    cpSync(resolve(root, file), resolve(target, file), { recursive: true });
  return target;
}

function plant(target, file, find, replace) {
  const path = resolve(target, file);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(find), `planting point missing in ${file}`);
  writeFileSync(path, text.replace(find, replace));
}

test('the tree passes', () => {
  assert.deepEqual(judgeWalls(root), []);
});

for (const [name, planted] of [
  ['a new refusal', `if (item.reason === 'schedule') throw new Error('schedules are paused');\n    `],
  ['a new early return', `if (item.agentDepth > 2) return;\n    `],
  ['a new wait', `await new Promise(done => setTimeout(done, 1_000));\n    `],
  ['a new cap', `if (this.places.size > this.admissionLimit) place.waiting.push(item);\n    `],
]) {
  test(`a planted ${name} on the path fails`, () => {
    const target = copy();
    try {
      plant(target, 'apps/body/src/agent-runner.ts', 'place.running = item;\n    ', `place.running = item;\n    ${planted}`);
      const errors = judgeWalls(target);
      assert.ok(errors.some(error => error.startsWith('not a wall: apps/body/src/agent-runner.ts deliver:')), errors.join('\n'));
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
}

test('a renamed path function fails instead of escaping the scan', () => {
  const target = copy();
  try {
    plant(target, 'apps/body/src/agent-runner.ts', 'private async post(', 'private async publish(');
    assert.ok(judgeWalls(target).some(error => error.includes('path function post is missing')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('a listed site that no longer exists fails', () => {
  const target = copy();
  try {
    plant(target, WALLS_FILE, '## `stop` Stop\n', '## `stop` Stop\n\n- `apps/body/src/agent-runner.ts pump: refuse throw gone`\n');
    assert.ok(judgeWalls(target).some(error => error.includes('lists a site that is not in the code')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('a sixth wall fails', () => {
  const target = copy();
  try {
    plant(target, WALLS_FILE, '## `stop` Stop', '## `busy` Busy agents\n\n## `stop` Stop');
    assert.ok(judgeWalls(target).some(error => error.includes('must list exactly these walls')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

for (const [name, code] of [
  ['refusal', "if (placeId === 'blocked') throw new Error('new startup refusal');"],
  ['optional read', "await api.execute('getAgentConfiguration', { agentId: agent.publicKey });"],
  ['setup dependency', 'await installNewDependency();'],
]) {
  test(`a planted startup ${name} fails`, () => {
    const target = copy();
    try {
      plant(target, 'apps/body/src/place-session.ts', '    const corner = Boolean(parentRoomId);', `${code}\n    const corner = Boolean(parentRoomId);`);
      assert.ok(judgeWalls(target).some(error => error.startsWith('not a wall: apps/body/src/place-session.ts activate:')), judgeWalls(target).join('\n'));
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
}

test('a new dependency hidden in credential preparation fails', () => {
  const target = copy();
  try {
    plant(target, 'apps/body/src/agent-home.ts', '  const root = resolve(input.root);', '  await installNewDependency();\n  const root = resolve(input.root);');
    assert.ok(judgeWalls(target).some(error => error.startsWith('not a wall: apps/body/src/agent-home.ts')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('a long listed guard cannot hide a new refusal behind a truncated fingerprint', () => {
  const target = copy();
  try {
    const first = `${'a'.repeat(200)}first`, second = `${'a'.repeat(200)}second`;
    plant(target, 'apps/body/src/agent-runner.ts', 'place.running = item;\n    ', `place.running = item;\n    if (item.reason === '${first}') throw new Error('refuse');\n    `);
    const site = judgeWalls(target).find(error => error.startsWith('not a wall:')).split('\n')[0].slice('not a wall: '.length);
    plant(target, WALLS_FILE, '## `stop` Stop', `## \`stop\` Stop\n\n- \`${site}\``);
    assert.deepEqual(judgeWalls(target), []);
    plant(target, 'apps/body/src/agent-runner.ts', first, second);
    assert.ok(judgeWalls(target).some(error => error.startsWith('not a wall:')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});
