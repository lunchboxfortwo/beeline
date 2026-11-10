import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withKernelLock } from '../kernel-lock.js';
import { waitForProcessExit } from '../process-exit.js';
import { pidAlive, readState, hasLocalDelivery, stateDir } from './store.js';
import type { Runner } from './bridge.js';
import { notifyBridgeSessions } from './bridge.js';
import { bridgeSocketPath } from './bridge-socket.js';

export function bridgeRunning(dir: string): boolean {
  try { const pid = Number(readFileSync(join(dir, 'bridge.pid'), 'utf8')); return pid > 0 && pidAlive(pid); } catch { return false; }
}

export function bundleDigest(runner: Runner): string {
  return createHash('sha256').update(readFileSync(runner.bundle)).digest('hex');
}

function bridgeOwner(dir: string): { pid: number; digest: string } | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'bridge-owner.json'), 'utf8')); } catch { return undefined; }
}

/** A stale private pid file must never authorize signalling an unrelated process. */
function isBridgeProcess(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return args.length === 4 && /^node(?:\.exe)?$/.test(basename(args[0]!)) &&
        /^(?:beeline|usebeeline\.mjs|recovery-cli\.mjs)$/.test(basename(args[1]!)) && args[2] === 'session' && args[3] === 'bridge';
    }
    const args = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
    return /(?:^|\/)node\s+.*\/(?:beeline|usebeeline\.mjs|recovery-cli\.mjs) session bridge$/.test(args);
  } catch { return false; }
}

function message(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((done, fail) => {
    const finish = (error?: Error) => {
      child.removeListener('message', received); child.removeListener('error', failed); child.removeListener('exit', exited);
      if (error) fail(error); else done();
    };
    const received = (value: unknown) => { if (value === expected) finish(); };
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error(`Beeline bridge exited before ${expected}; see bridge.log`));
    child.on('message', received); child.once('error', failed); child.once('exit', exited);
    if (child.exitCode !== null || child.signalCode !== null) exited();
  });
}

/** Startup is a two-phase handoff. The candidate opens its real streams but
 * cannot consume deliveries until the serving process has drained and exited. */
export async function ensureBridge(dir: string, runner: Runner, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await withKernelLock(`beeline-session-bridge:${resolve(dir)}`, async () => {
    const source = runner.candidate ?? runner.bundle;
    const digest = bundleDigest({ ...runner, bundle: source });
    const pidFile = join(dir, 'bridge.pid');
    let old: number | undefined;
    if (bridgeRunning(dir)) {
      old = Number(readFileSync(pidFile, 'utf8'));
      if (!isBridgeProcess(old)) throw new Error('Beeline bridge PID belongs to an unrecognized process; refusing takeover');
      const owner = bridgeOwner(dir);
      if (owner?.pid === old && owner.digest === digest) {
        await notifyBridgeSessions(dir);
        return;
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stable = join(dir, 'usebeeline.mjs');
    const previous = existsSync(stable) ? readFileSync(stable) : undefined;
    // Keep ephemeral directories outside the serving bridge's recursive
    // watch: deleting a newly observed tree can fail Node's recursive watcher.
    const staging = mkdtempSync(join(dirname(dir), '.beeline-bridge-candidate-'));
    const bundle = join(staging, 'usebeeline.mjs');
    writeFileSync(bundle, readFileSync(source), { mode: 0o600 });
    const out = openSync(join(dir, 'bridge.log'), 'a', 0o600);
    const child = spawn(runner.node, [bundle, 'session', 'bridge'], {
      detached: true, stdio: ['ignore', out, out, 'ipc'],
      env: { ...env, BEELINE_SESSION_BUNDLE: bundle, BEELINE_SESSION_BRIDGE_STAGING: '1' },
    });
    closeSync(out);
    let published = false;
    try {
      await message(child, 'ready');
      const active = message(child, 'active');
      // Observe a candidate death even while the old process drains.
      void active.catch(() => undefined);
      if (old) {
        try { process.kill(old, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await waitForProcessExit(old);
        if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) === old) rmSync(pidFile);
      }
      renameSync(bundle, stable); published = true;
      child.send('activate');
      await active;
      child.disconnect(); child.unref();
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill(); await waitForProcessExit(child.pid);
      }
      if (published) {
        if (previous) {
          const restore = join(staging, 'usebeeline.mjs');
          writeFileSync(restore, previous, { mode: 0o600 }); renameSync(restore, stable);
        } else rmSync(stable, { force: true });
      }
      throw error;
    } finally {
      if (child.pid) rmSync(bridgeSocketPath(dir, child.pid), { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

/** Recovery must also run a retained pre-handoff release. Its readiness
 * contract was bridge-owner.json, so do not require the new IPC protocol. */
async function recoverRetainedBridge(dir: string, stable: string, env: NodeJS.ProcessEnv): Promise<void> {
  await withKernelLock(`beeline-session-bridge:${resolve(dir)}`, async () => {
    if (bridgeRunning(dir)) return;
    const digest = bundleDigest({ node: process.execPath, bundle: stable });
    const out = openSync(join(dir, 'bridge.log'), 'a', 0o600);
    const child = spawn(process.execPath, [stable, 'session', 'bridge'], {
      detached: true, stdio: ['ignore', out, out],
      env: { ...env, BEELINE_SESSION_BUNDLE: stable, BEELINE_SESSION_BRIDGE_STAGING: '' },
    });
    closeSync(out);
    await new Promise<void>((done, fail) => {
      const finish = (error?: Error) => {
        watcher.close(); child.removeListener('error', failed); child.removeListener('exit', exited);
        if (error) fail(error); else done();
      };
      const inspect = () => {
        const owner = bridgeOwner(dir);
        if (owner && owner.pid === child.pid && owner.digest === digest) finish();
      };
      const failed = (error: Error) => finish(error);
      const exited = () => finish(new Error('Retained Beeline bridge exited before readiness; see bridge.log'));
      const watcher = watch(dir, (_event, name) => { if (String(name) === 'bridge-owner.json') inspect(); });
      child.once('error', failed); child.once('exit', exited); inspect();
    });
    child.unref();
  });
}

/** A failed release cannot overwrite the last working bundle. If its process
 * was already dead, recover that retained bundle once, then report the failure
 * through the helper's existing upgrade warning as well as bridge.log. */
export async function refreshJoinedSessionBridge(bundle: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = stateDir(env);
  if (!readState(dir).sessions.some(hasLocalDelivery)) return;
  try { await ensureBridge(dir, { node: process.execPath, bundle }, env); }
  catch (error) {
    writeFileSync(join(dir, 'bridge.log'), `bridge upgrade failed: ${String(error)}\n`, { flag: 'a', mode: 0o600 });
    const stable = join(dir, 'usebeeline.mjs');
    if (!bridgeRunning(dir) && existsSync(stable)) {
      await recoverRetainedBridge(dir, stable, env);
    }
    throw error;
  }
}
