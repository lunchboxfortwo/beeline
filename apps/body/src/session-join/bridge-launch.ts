import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withKernelLock } from '../kernel-lock.js';
import { pidAlive, readState, hasLocalDelivery, stateDir } from './store.js';
import type { Runner } from './bridge.js';
import { notifyBridgeSessions } from './bridge.js';
import { bridgeOwnerKey, bridgeSocketPath } from './bridge-socket.js';
import { answer, launchDetached, runOwnedFile, tryLock } from '../wait.js';

export function bridgeRunning(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, 'bridge.pid'), 'utf8'));
    return pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
}

export function bundleDigest(runner: Runner): string {
  return createHash('sha256').update(readFileSync(runner.bundle)).digest('hex');
}

function bridgeOwner(dir: string): { pid: number; digest: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'bridge-owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** A stale private pid file must never authorize signalling an unrelated process. */
async function isBridgeProcess(pid: number): Promise<boolean> {
  try {
    if (process.platform === 'linux') {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return (
        args.length === 4 &&
        /^node(?:\.exe)?$/.test(basename(args[0]!)) &&
        /^(?:beeline|usebeeline\.mjs|recovery-cli\.mjs)$/.test(basename(args[1]!)) &&
        args[2] === 'session' &&
        args[3] === 'bridge'
      );
    }
    const args = (
      await runOwnedFile('ps', ['-ww', '-p', String(pid), '-o', 'args='])
    ).stdout.trim();
    return /(?:^|\/)node\s+.*\/(?:beeline|usebeeline\.mjs|recovery-cli\.mjs) session bridge$/.test(
      args,
    );
  } catch {
    return false;
  }
}

/** The candidate's IPC message `expected`, or its exit, error or lost channel first. */
function message(child: ChildProcess, expected: string): Promise<void> {
  const lost = () => new Error(`Beeline bridge exited before ${expected}; see bridge.log`);
  let received: ((value: unknown) => void) | undefined;
  return answer<void>(
    'Beeline bridge candidate',
    [
      [child, 'error'],
      [child, 'exit', lost],
      [child, 'disconnect', lost],
    ],
    ({ resolve }) => {
      received = (value) => {
        if (value === expected) resolve();
      };
      child.on('message', received);
    },
  ).finally(() => {
    if (received) child.removeListener('message', received);
  });
}

/** Startup is a two-phase handoff. The candidate opens its real streams but
 * cannot consume deliveries until the serving process has drained and exited. */
export async function ensureBridge(
  dir: string,
  runner: Runner,
  env: NodeJS.ProcessEnv = process.env,
  options: { onlyIfAbsent?: boolean } = {},
): Promise<void> {
  await withKernelLock(`beeline-session-bridge:${resolve(dir)}`, async () => {
    // Recovery starts a bridge only where none serves; it never replaces one.
    if (options.onlyIfAbsent && bridgeRunning(dir)) return;
    const source = runner.candidate ?? runner.bundle;
    const digest = bundleDigest({ ...runner, bundle: source });
    const pidFile = join(dir, 'bridge.pid');
    let old: number | undefined;
    if (bridgeRunning(dir)) {
      old = Number(readFileSync(pidFile, 'utf8'));
      if (!(await isBridgeProcess(old)))
        throw new Error('Beeline bridge PID belongs to an unrecognized process; refusing takeover');
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
    // It must outlive this command; the IPC channel lasts only through the handshake.
    let launched: ReturnType<typeof launchDetached>;
    try {
      launched = launchDetached({
        file: runner.node,
        args: [bundle, 'session', 'bridge'],
        stdio: ['ignore', out, out],
        ipc: true,
        env: { ...env, BEELINE_SESSION_BUNDLE: bundle, BEELINE_SESSION_BRIDGE_STAGING: '1' },
      });
    } finally {
      closeSync(out);
    }
    const child = launched.child;
    let published = false;
    try {
      await message(child, 'ready');
      const active = message(child, 'active');
      // Observe a candidate death even while the old process drains.
      void active.catch(() => undefined);
      if (old) {
        // A serving bridge holds its owner lock until it exits; the kernel closes it on exit or death.
        const owner = await tryLock(bridgeOwnerKey(dir));
        if (owner.held) {
          await owner.release();
          throw new Error('Beeline bridge has no followable owner channel; refusing takeover');
        }
        if (owner.holder.pid !== old) {
          owner.close();
          throw new Error('Beeline bridge owner changed; refusing takeover');
        }
        try {
          try {
            process.kill(old, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          // The candidate dying while the old owner drains ends this takeover too.
          await Promise.race([owner.released(), active]);
        } finally {
          owner.close();
        }
        if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) === old) rmSync(pidFile);
      }
      renameSync(bundle, stable);
      published = true;
      child.send('activate');
      await active;
      launched.release();
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await launched.exited;
      }
      if (published) {
        if (previous) {
          const restore = join(staging, 'usebeeline.mjs');
          writeFileSync(restore, previous, { mode: 0o600 });
          renameSync(restore, stable);
        } else rmSync(stable, { force: true });
      }
      throw error;
    } finally {
      if (child.pid) rmSync(bridgeSocketPath(dir, child.pid), { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

/**
 * Recovery runs the retained bundle when no bridge serves. One that speaks
 * the staged handshake (since #4096) is recovered through it, so recovery
 * settles on the candidate's own ready/active, exit or error, serialized by
 * the launch lock and proven ownership. An older, marker-only bundle is
 * launched without a readiness wait: a candidate claims ownership before it
 * publishes anything, so a concurrent start cannot replace the socket it serves.
 */
async function recoverRetainedBridge(
  dir: string,
  stable: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (readFileSync(stable, 'utf8').includes('BEELINE_SESSION_BRIDGE_STAGING')) {
    await ensureBridge(dir, { node: process.execPath, bundle: stable }, env, {
      onlyIfAbsent: true,
    });
    return;
  }
  await withKernelLock(`beeline-session-bridge:${resolve(dir)}`, async () => {
    if (bridgeRunning(dir)) return;
    const out = openSync(join(dir, 'bridge.log'), 'a', 0o600);
    try {
      launchDetached({
        file: process.execPath,
        args: [stable, 'session', 'bridge'],
        stdio: ['ignore', out, out],
        env: { ...env, BEELINE_SESSION_BUNDLE: stable, BEELINE_SESSION_BRIDGE_STAGING: '' },
      });
    } finally {
      closeSync(out);
    }
  });
}

/** A failed release cannot overwrite the last working bundle. If its process
 * was already dead, recover that retained bundle once, then report the failure
 * through the helper's existing upgrade warning as well as bridge.log. */
export async function refreshJoinedSessionBridge(
  bundle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = stateDir(env);
  if (!readState(dir).sessions.some(hasLocalDelivery)) return;
  try {
    await ensureBridge(dir, { node: process.execPath, bundle }, env);
  } catch (error) {
    writeFileSync(join(dir, 'bridge.log'), `bridge upgrade failed: ${String(error)}\n`, {
      flag: 'a',
      mode: 0o600,
    });
    const stable = join(dir, 'usebeeline.mjs');
    if (!bridgeRunning(dir) && existsSync(stable)) {
      // A failed recovery has its own diagnostic; the caller still gets the upgrade's error.
      await recoverRetainedBridge(dir, stable, env).catch((recovery: unknown) =>
        writeFileSync(join(dir, 'bridge.log'), `bridge recovery failed: ${String(recovery)}\n`, {
          flag: 'a',
          mode: 0o600,
        }),
      );
    }
    throw error;
  }
}
