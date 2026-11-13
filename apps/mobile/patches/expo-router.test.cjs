const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

// Execute the patched dependency, including its real path matching and sorting.
function loadRouter(patched) {
  const original = path.resolve(__dirname, '../node_modules/expo-router/build/fork/getStateFromPath.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-router-'));
  const target = path.join(directory, 'node_modules/expo-router/build/fork/getStateFromPath.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(original, target);
  try {
    if (patched) {
      const result = spawnSync('patch', ['-p1', '-d', directory], {
        input: fs.readFileSync(path.join(__dirname, 'expo-router+55.0.17.patch')), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const dependencyRequire = createRequire(original);
    let validations = 0;
    const exports = {};
    vm.runInNewContext(fs.readFileSync(target, 'utf8'), {
      exports, process,
      require: name => name === '@react-navigation/native'
        ? { validatePathConfig: () => { validations += 1; } } : dependencyRequire(name),
    });
    return { parse: exports.getStateFromPath, validations: () => validations };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('reuses route definitions while preserving group preference, params and new options', () => {
  const baseline = loadRouter(false);
  const patched = loadRouter(true);
  const config = { screens: {
    '(home)': { path: '(home)', screens: { chat: 'chat/:id' } },
    '(work)': { path: '(work)', screens: { chat: 'chat/:id' } },
  } };
  for (const [url, segments] of [
    ['/chat/one', ['(home)', 'chat']], ['/chat/two?hello=world', ['(work)', 'chat']],
    ['/chat/three', ['(home)', 'chat']], ['/chat/four', ['(work)', 'chat']],
  ]) {
    assert.equal(JSON.stringify(patched.parse(url, config, segments)),
      JSON.stringify(baseline.parse(url, config, segments)));
  }
  assert.equal(patched.validations(), 1);
  const changed = { screens: { person: 'people/:id' } };
  assert.equal(JSON.stringify(patched.parse('/people/new', changed)),
    JSON.stringify(baseline.parse('/people/new', changed)));
  assert.equal(patched.validations(), 2);
});
