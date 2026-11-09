#!/usr/bin/env node
// Run through an approved host command grant so the job outlives the harness.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const [action, directory, ...args] = process.argv.slice(2);
if (!directory || !['start', 'status', 'worker'].includes(action)) {
  throw new Error('Usage: node scripts/corner-job.mjs start|status <job-directory> [command args...]');
}
const root = resolve(directory);
if (action === 'status') {
  for (const file of ['started.json', 'result.json', 'output.log']) {
    try { process.stdout.write(`${file}:\n${readFileSync(resolve(root, file), 'utf8')}\n`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
} else if (action === 'start') {
  if (!args.length) throw new Error('A command and its arguments are required');
  // An exclusive directory avoids mixing evidence or overwriting a running job.
  mkdirSync(root, { mode: 0o700 });
  const log = openSync(resolve(root, 'output.log'), 'wx', 0o600);
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', root, ...args], {
    detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  closeSync(log);
  worker.once('error', error => { console.error(error.message); process.exitCode = 1; });
  worker.once('spawn', () => {
    writeFileSync(resolve(root, 'started.json'), JSON.stringify({ pid: worker.pid, cwd: process.cwd(), command: args, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    worker.unref();
    console.log(`Job started. Read ${root}/output.log and ${root}/result.json on the next turn.`);
  });
} else {
  // Give the build a separate process group. GNU timeout bounds its runtime;
  // this worker also owns descendants after the immediate build process exits.
  const child = spawn('timeout', ['--signal=TERM', '--kill-after=10s', '4h', ...args], { detached: true, stdio: 'inherit' });
  const signalGroup = signal => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  };
  const finish = result => writeFileSync(resolve(root, 'result.json'), JSON.stringify({ ...result, finishedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  child.once('error', error => { console.error(error.message); finish({ exitCode: null, error: error.message }); process.exitCode = 1; });
  child.once('exit', async (exitCode, signal) => {
    // timeout stops watching when its immediate child exits, even if that child
    // left background tools behind. Keep supervision until those tools stop.
    try {
      if (signalGroup('SIGTERM')) {
        await pause(1000);
        signalGroup('SIGKILL');
        // Signals are asynchronous. Wait until every member has stopped before
        // publishing completion; orphan zombies are already dead and init reaps them.
        for (let attempt = 0; ; attempt++) {
          const groups = execFileSync('ps', ['-eo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 });
          const running = groups.trim().split('\n').some(line => {
            const [group, state] = line.trim().split(/\s+/);
            return group === String(child.pid) && !/^[ZX]/.test(state ?? '');
          });
          if (!running) break;
          if (attempt === 100) throw new Error('Build process group did not stop after SIGKILL');
          await pause(10);
        }
      }
      finish({ exitCode, signal });
      console.log(`Job finished: exit ${exitCode ?? signal}`);
      process.exitCode = exitCode ?? 1;
    } catch (error) {
      console.error(`Job cleanup failed: ${error.message}`);
      finish({ exitCode, signal, cleanupError: error.message });
      process.exitCode = 1;
    }
  });
}
