import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

test('host job survives its launching command and exposes output and failing status to the next command', async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'beeline-job-proof-'));
  const directory = resolve(temporary, 'job');
  try {
    execFileSync(process.execPath, ['scripts/corner-job.mjs', 'start', directory, process.execPath, '-e',
      'console.log("build started"); setTimeout(() => {console.error("build failed visibly"); process.exitCode = 7}, 250)']);
    for (let attempt = 0; attempt < 100 && !existsSync(resolve(directory, 'result.json')); attempt++) await pause(50);
    assert.equal(JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8')).exitCode, 7);
    const output = execFileSync(process.execPath, ['scripts/corner-job.mjs', 'status', directory], { encoding: 'utf8' });
    assert.match(output, /build started/);
    assert.match(output, /build failed visibly/);
    assert.match(output, /Job finished: exit 7/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

// Linux host jobs must finish their whole process group before publishing a result.
for (const [outcome, expected] of [['success', 0], ['failure', 7], ['timeout', 124]]) {
  test(`cleans up a surviving background child after build ${outcome}`, async () => {
    const temporary = mkdtempSync(resolve(tmpdir(), 'beeline-job-descendant-'));
    const directory = resolve(temporary, 'job');
    const ready = resolve(temporary, 'child-ready');
    let descendant;
    try {
      const bin = resolve(temporary, 'bin');
      mkdirSync(bin);
      // Keep a safety bound; trigger GNU timeout only after the child is ready.
      // SIGALRM is the signal its deadline uses, so runner startup is not timed.
      writeFileSync(resolve(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec /usr/bin/timeout --signal=TERM --kill-after=1s 30s "$@"\n', { mode: 0o755 });
      const childCode = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const parentCode = `
        const fs = require('node:fs');
        // Reproduce a busy runner taking longer than the old half-second deadline.
        setTimeout(() => require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }).unref(), 750);
        const wait = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(ready)})) return;
          clearInterval(wait);
          ${outcome === 'timeout' ? "setInterval(() => {}, 1000); process.kill(process.ppid, 'SIGALRM');" : `process.exitCode = ${expected};`}
        }, 10);
      `;
      execFileSync(process.execPath, ['scripts/corner-job.mjs', 'start', directory, process.execPath, '-e', parentCode], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      for (let attempt = 0; attempt < 200 && !existsSync(resolve(directory, 'result.json')); attempt++) await pause(50);
      descendant = Number(readFileSync(ready, 'utf8'));
      assert.equal(JSON.parse(readFileSync(resolve(directory, 'result.json'), 'utf8')).exitCode, expected);
      // An orphan may briefly remain as a zombie until the host init reaps it.
      let running = false;
      try { running = !/\) Z /.test(readFileSync(`/proc/${descendant}/stat`, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(running, false, 'result was published while the build descendant was still running');
    } finally {
      if (!descendant && existsSync(ready)) descendant = Number(readFileSync(ready, 'utf8'));
      if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
