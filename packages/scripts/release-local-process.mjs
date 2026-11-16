import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class Processes {
  constructor(secrets = {}, log = console.log) {
    this.logs = new AsyncLocalStorage();
    this.masks = new Set(Object.values(secrets).filter(v => typeof v === 'string' && v.length > 3));
    this.log = value => {
      const safe = this.redact(String(value));
      const logFile = this.logs.getStore() || this.logFile;
      if (logFile) appendFileSync(logFile, `${safe}\n`, { mode: 0o600 });
      log(safe);
    };
    this.children = new Set();
  }
  withLogFile(path, run) { return this.logs.run(path, run); }
  mask(value) { if (value?.length > 3) this.masks.add(value); }
  redact(value) {
    for (const secret of [...this.masks].sort((a, b) => b.length - a.length)) value = value.split(secret).join('***');
    return value;
  }
  async run(command, args, { cwd, env, input, timeout = 30 * 60_000, quiet = false } = {}) {
    return new Promise((resolveRun, reject) => {
      const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child);
      let output = '', pending = '', timedOut = false;
      const emit = line => {
        if (line.startsWith('::add-mask::')) { this.mask(line.slice(12)); return; }
        const safe = this.redact(line);
        output += `${safe}\n`;
        if (!quiet) this.log(safe);
      };
      // Buffer complete lines so a split token or add-mask command cannot leak.
      child.stdout.on('data', chunk => {
        pending += chunk.toString();
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) { emit(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      });
      let errors = '';
      child.stderr.on('data', chunk => {
        errors += chunk.toString();
        let newline;
        while ((newline = errors.indexOf('\n')) >= 0) { emit(errors.slice(0, newline)); errors = errors.slice(newline + 1); }
      });
      const kill = signal => {
        try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); }, timeout);
      const hardTimer = setTimeout(() => kill('SIGKILL'), timeout + 10_000);
      child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); this.children.delete(child); reject(error); });
      child.once('close', (status, signal) => {
        clearTimeout(timer); clearTimeout(hardTimer); this.children.delete(child);
        if (pending) emit(pending);
        if (errors) emit(errors);
        if (status === 0 && !timedOut) resolveRun(output);
        else reject(new Error(`${command} failed (${timedOut ? 'timeout' : signal || status})`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  cancel() {
    for (const child of this.children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  }
}

export function privateWrite(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
}
export function readOptional(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export function appendSummary(path, text) { appendFileSync(path, `${text}\n`, { mode: 0o600 }); }
