import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readInvariants, strictRelaxations } from './architecture-invariants.mjs';

it('the real architecture check rejects every server timer outside the schedule and shutdown owners', () => {
  const parent = path.resolve('.beeline-proof');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'server-timers-'));
  const rules = readInvariants(process.cwd()).rules.filter(rule => rule.id.startsWith('timers.server-') || rule.id === 'timers.shutdown-sites');
  const invariants = { rules };
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const check = () => spawnSync(process.execPath, ['scripts/check-architecture.mjs', '--root', root], { encoding: 'utf8' });
  try {
    write('architecture/invariants.json', JSON.stringify(invariants));
    write('architecture/machine-connection-sinks.json', '{}');
    write('apps/server/src/owner-schedule-clock.ts', 'setTimeout(fireSchedule, dueTime);');
    write('apps/server/src/shutdown.ts', 'setTimeout(exit, 10000); setTimeout(drain, 5000); setTimeout(terminate, 1000);');
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    for (const source of [
      'setTimeout(rewakeAnsweredMention, 30000);',
      'setInterval(sweep, 60000);',
      "import { setInterval as repeat } from 'node:timers'; repeat(sweep, 1000);",
      "import { setTimeout as retry } from 'node:timers/promises'; retry(1000);",
      'AbortSignal.timeout(1000);',
      'globalThis.setTimeout(nudge, 500);',
      'socket.setTimeout(1000, retry);',
    ]) {
      write('apps/server/src/planted-background.ts', source);
      const result = check();
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, /timers\.server-/);
    }
    write('apps/server/src/planted-background.ts', '');
    write('apps/server/src/shutdown.ts', 'setTimeout(exit, 10000); setTimeout(drain, 5000); setTimeout(terminate, 1000); setTimeout(extra, 100);');
    const extraDeadline = check();
    assert.equal(extraDeadline.status, 1);
    assert.match(extraDeadline.stderr, /timers\.shutdown-sites/);
    const weakened = structuredClone(invariants);
    weakened.rules.find(rule => rule.id === 'timers.server-timeout').owners.push('apps/server/src/planted-background.ts');
    assert.ok(strictRelaxations(root, invariants, weakened).length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('permits only the bounded shutdown timer owner migration', () => {
  const rule = readInvariants(process.cwd()).rules.find(rule => rule.id === 'timers.server-timeout');
  const before = { ...rule, owners: ['apps/server/src/owner-schedule-clock.ts'] };
  assert.deepEqual(strictRelaxations('', { rules: [before] }, { rules: [rule] }), []);
  for (const owners of [
    [...rule.owners, 'apps/server/src/background.ts'],
    ['apps/server/src/shutdown.ts'],
  ]) assert.ok(strictRelaxations('', { rules: [before] }, { rules: [{ ...rule, owners }] }).length);
  assert.ok(strictRelaxations('', { rules: [rule] }, { rules: [{ ...rule, owners: [...rule.owners, 'extra.ts'] }] }).length);
});
