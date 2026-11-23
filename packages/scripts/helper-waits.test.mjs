import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readInvariants, strictRelaxations } from './architecture-invariants.mjs';

// A planted wait outside apps/body/src/wait.ts must fail the same CI guard as production.
it('the real architecture check rejects a helper wait or timer outside ask/runOwned/tryLock', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helper-waits-'));
  const real = readInvariants(process.cwd()).rules.find((rule) => rule.id === 'helper.waits');
  assert.ok(real);
  assert.equal(real.strict, true);
  // The fixture tree holds only the owners, so it allows no other site.
  const rule = { ...real, total: 0 };
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const check = () =>
    spawnSync(process.execPath, ['packages/scripts/check-architecture.mjs', '--root', root], {
      encoding: 'utf8',
    });
  try {
    write('docs/architecture/invariants.json', JSON.stringify({ rules: [rule] }));
    write('docs/architecture/machine-connection-sinks.json', '{}');
    mkdirSync(path.join(root, 'apps/body/src'), { recursive: true });
    copyFileSync(
      path.join(process.cwd(), 'apps/body/src/wait.ts'),
      path.join(root, 'apps/body/src/wait.ts'),
    );
    // The agent stay-warm countdown is the one timer owned outside wait.ts.
    write(
      'apps/body/src/agent-runner.ts',
      'class AgentRunner { private armIdle() { this.timer = setTimeout(stop, 1); } }\n',
    );
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    for (const source of [
      'await new Promise((done) => setTimeout(done, 600_000));',
      'const heartbeat = setInterval(() => progress("still working"), 1000);',
      "await new Promise((done) => child.once('close', done));",
      'watch(dirname(path), () => reconnect());',
      'const peer = createConnection(path);',
      'await fetch(url, { signal: undefined });',
      "spawn('npm', ['install'], { detached: true }).unref();",
      "execFileSync('git', ['status']);",
    ]) {
      write('apps/body/src/planted-wait.ts', source);
      const result = check();
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /helper\.waits/);
      assert.match(result.stderr, /use ask\/runOwned\/tryLock in apps\/body\/src\/wait\.ts/);
    }
    write('apps/body/src/planted-wait.ts', '');
    // A second wait implementation inside the owner file also fails.
    const owner = readFileSync(path.join(process.cwd(), 'apps/body/src/wait.ts'), 'utf8');
    write(
      'apps/body/src/wait.ts',
      `${owner}\nfunction waitForIdle() { return new Promise(done => setTimeout(done, 1000)); }\n`,
    );
    const extra = check();
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /helper\.waits/);
    // Its boundary cannot be relaxed through a candidate rule edit.
    for (const weakened of [
      { ...real, total: real.total + 1 },
      { ...real, owners: [...real.owners, 'apps/body/src/planted-wait.ts'] },
      {
        ...real,
        ownerFunctions: {
          ...real.ownerFunctions,
          'apps/body/src/wait.ts': [...real.ownerFunctions['apps/body/src/wait.ts'], 'waitForIdle'],
        },
      },
      { ...real, strict: false },
    ])
      assert.ok(
        strictRelaxations(root, { rules: [real] }, { rules: [weakened] }).length,
        JSON.stringify(weakened).slice(0, 80),
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
