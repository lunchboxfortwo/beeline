import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCornerMachineSource, checkCornerMachine } from './corner-machine-boundary.mjs';

it('freezes the real corner tree to one state/wake owner', () => {
  assert.deepEqual(checkCornerMachine(process.cwd()), []);
});
it('rejects planted state and wake backdoors, including a renamed queue import', () => {
  for (const source of [
    "db.query('UPDATE rooms SET archived_at=now() WHERE id=$1')",
    'db.query(`UPDATE corner_facts SET machine=$1 WHERE corner_id=$2`)',
    "db.query('INSERT INTO corner_facts(corner_id,machine) VALUES($1,$2)')",
    "db.query('INSERT INTO corner_github_cache(corner_id) VALUES($1)')",
    'db.query(`UPDATE corner_github_cache SET lifecycle=$2 WHERE corner_id=$1`)',
    "db.query('DELETE FROM corner_github_cache WHERE corner_id=$1')",
    'db.query(`UPDATE "public"."corner_github_cache" SET lifecycle=$2 WHERE corner_id=$1`)',
    "createAgentCommand(db,{roomId:cornerId,reason:'corner_check'})",
    "import { createAgentCommand as wake } from './agent-command.js'; wake(db,{reason:'corner_review_dispatch'})",
    "import * as commands from './agent-command.js'; commands.insertAgentCommand(db,input)",
    "export { insertAgentCommand as wake } from './agent-command.js'",
    "import { insertAgentCommand as wake } from './agent-command.js'; wake(db,input)",
  ]) {
    assert.ok(
      inspectCornerMachineSource('apps/server/src/planted-backdoor.ts', source).length,
      source,
    );
    assert.deepEqual(inspectCornerMachineSource('apps/server/src/corner-lifecycle.ts', source), []);
  }
});

it('fails the architecture build gate for a planted cache write outside the owner', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'corner-machine-boundary-'));
  try {
    mkdirSync(path.join(root, 'apps/server/src'), { recursive: true });
    mkdirSync(path.join(root, 'packages/planted/src'), { recursive: true });
    mkdirSync(path.join(root, 'docs/architecture'), { recursive: true });
    writeFileSync(path.join(root, 'docs/architecture/invariants.json'), JSON.stringify({ rules: [] }));
    writeFileSync(path.join(root, 'docs/architecture/machine-connection-sinks.json'), '{}');
    const run = () => spawnSync(process.execPath, [
      fileURLToPath(new URL('./check-architecture.mjs', import.meta.url)), '--root', root,
    ], { encoding: 'utf8' });
    assert.equal(run().status, 0, 'the isolated tree passes before the planted write');
    writeFileSync(path.join(root, 'apps/server/src/planted-cache-write.ts'),
      "db.query('UPDATE corner_github_cache SET lifecycle=$2 WHERE corner_id=$1')");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /planted-cache-write\.ts:1: corner machine boundary: corner state write outside its owner/);
    rmSync(path.join(root, 'apps/server/src/planted-cache-write.ts'));
    writeFileSync(path.join(root, 'packages/planted/src/cache-write.ts'),
      "db.query('DELETE FROM corner_github_cache WHERE corner_id=$1')");
    const packageResult = run();
    assert.equal(packageResult.status, 1);
    assert.match(packageResult.stderr, /packages\/planted\/src\/cache-write\.ts:1: corner machine boundary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
