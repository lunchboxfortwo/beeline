import { progress } from './update-progress.js';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { withKernelLock } from './kernel-lock.js';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';
import { runOwned } from './wait.js';
import { startHelperWithAcknowledgment, type OlderHelperStarted } from './machine-control.js';
import { defaultSupervisorRoot } from './runtime.js';
import { activeReleaseId, anchorLayout, readBundleJson, readUpdateState, selectBootRelease } from './self-update.js';

function launchdJobPid(stdout: string): number {
  return Number(stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1] ?? '0');
}

async function launchdBundleVersion(env: NodeJS.ProcessEnv): Promise<string> {
  const layout = anchorLayout(resolve(homeFor(env), '.local/lib/beeline'));
  const state = await readUpdateState(layout);
  const selected = await selectBootRelease(layout, [state.stagedReleaseId, await activeReleaseId(layout)]);
  const identity = await readBundleJson(selected ? resolve(layout.releasesRoot, selected) : layout.libDir);
  if (!identity?.version) throw new Error('selected helper bundle has no version for startup acknowledgment');
  return identity.version;
}

/** A native manager command is an owned child; its nonzero exit carries stdout/stderr like execFile's error. */
async function native(
  file: 'systemctl' | 'launchctl',
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  const step = `${file} ${args.join(' ')}`;
  const result = await runOwned({ step, file, args, env });
  if (result.code !== 0)
    throw Object.assign(new Error(`${step} exited ${result.code ?? result.signal}: ${result.stderr.trim()}`), {
      code: result.code, stdout: result.stdout, stderr: result.stderr,
    });
  return { stdout: result.stdout };
}
export const SYSTEMD_HELPER_UNIT_NAME = 'beeline-helper.service';
export const LAUNCHD_HELPER_LABEL = 'app.usebeeline.helper';
export type NativeRunner = (args: string[]) => Promise<{ stdout: string }>;

export function helperServiceUnit(): string {
  return `[Unit]
Description=Beeline helper (every agent on this machine)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=all
Environment=BEELINE_MANAGED_BY_SYSTEMD=1
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/beeline helper-bootstrap
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=1s
CPUWeight=1000
IOWeight=1000
Nice=-5
OOMScoreAdjust=-1000
OOMPolicy=continue
TimeoutStartSec=240s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077
# A desktop-launched user manager may inherit Ubuntu's unprivileged_userns
# AppArmor profile. Without an explicit transition every agent inherits it too,
# so /usr/bin/bwrap cannot enter its package-provided bwrap profile.
# Do not set NoNewPrivileges or PrivateTmp on this outer service: systemd applies
# either before AppArmorProfile, which blocks this transition. Bubblewrap sets
# no-new-privs and a private /tmp inside each agent sandbox it creates.
AppArmorProfile=-unconfined

[Install]
WantedBy=default.target
`;
}

/** Converge an already-running install's restart policy without a lifecycle action. */
export async function refreshSystemdHelperUnit(options: {
  env?: NodeJS.ProcessEnv; run?: NativeRunner;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  const directory = resolve(env.XDG_CONFIG_HOME || resolve(homeFor(env), '.config'), 'systemd/user');
  const path = resolve(directory, SYSTEMD_HELPER_UNIT_NAME);
  if ((await readFile(path, 'utf8').catch(() => '')) !== helperServiceUnit()) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, helperServiceUnit(), { mode: 0o600 });
    await rename(temporary, path);
  }
  // Retry even when the file matches: a previous helper may have died or
  // lost the bus between rename and daemon-reload.
  if (options.run) await options.run(['daemon-reload']);
  else await native('systemctl', ['--user', 'daemon-reload'], env);
}

function homeFor(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}
export function nativeSupervisor(env: NodeJS.ProcessEnv = process.env): 'systemd' | 'launchd' {
  if (process.platform === 'linux' && env.BEELINE_SYSTEMD_USER !== '0') return 'systemd';
  if (process.platform === 'darwin' && env.BEELINE_LAUNCHD_USER !== '0') return 'launchd';
  throw new Error(
    'Beeline requires the native user service manager; use daemon --config only in an isolated lab',
  );
}
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
export function nativeHelperPlist(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeFor(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_HELPER_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(resolve(home, '.local/bin/beeline'))}</string><string>helper-bootstrap</string></array>
<key>EnvironmentVariables</key><dict><key>BEELINE_MANAGED_BY_LAUNCHD</key><string>1</string><key>HOME</key><string>${xml(home)}</string><key>XDG_STATE_HOME</key><string>${xml(defaultSupervisorRoot(env))}</string><key>PATH</key><string>${xml(resolve(home, '.local/bin'))}:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>90</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(resolve(home, 'Library/Logs/Beeline/helper.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(home, 'Library/Logs/Beeline/helper.log'))}</string>
</dict></plist>
`;
}

/** Forward topology migration belongs here once, before the sole helper starts. */
interface NativeConvergenceOptions {
  env?: NodeJS.ProcessEnv;
  run?: NativeRunner;
  platform?: 'systemd' | 'launchd';
  restart?: boolean;
  legacyCaller?: string;
}

/**
 * The native transaction runs in an owned worker: it ends when the worker
 * exits (systemd's own job timeouts bound `start`), its progress streams, and
 * it dies with this command.
 */
export async function convergeNativeHelper(options: NativeConvergenceOptions = {}): Promise<number | OlderHelperStarted> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  progress('native service convergence');
  if (options.run) return convergeNativeHelperOwned(options);
  const entry = env.BEELINE_RECOVERY_ENTRY || process.argv[1];
  if (!entry) throw new Error('native service convergence requires a CLI entry');
  const step = 'native service convergence';
  const worker = await runOwned({
    step,
    file: process.execPath,
    args: [entry, 'native-converge-worker'],
    env: { ...env, BEELINE_NATIVE_CONVERGENCE: JSON.stringify({ platform: options.platform,
      restart: options.restart, legacyCaller: options.legacyCaller }), BEELINE_INTERNAL_NATIVE_WORKER: '1' },
    ownerLink: true,
  });
  if (worker.code !== 0) throw new Error(`${step}: worker exited ${worker.code ?? worker.signal}`);
  const pid = JSON.parse(worker.stdout).pid as number | OlderHelperStarted;
  if (typeof pid === 'object' && pid?.older === true && Number.isSafeInteger(pid.pid) && pid.pid > 0) return pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0) throw new Error('native convergence returned an invalid pid');
  return pid;
}

export async function runNativeConvergenceWorker(): Promise<number | OlderHelperStarted> {
  if (process.env.BEELINE_INTERNAL_NATIVE_WORKER !== '1')
    throw new Error('native convergence worker requires its recovery owner');
  const options = JSON.parse(process.env.BEELINE_NATIVE_CONVERGENCE || '{}') as NativeConvergenceOptions;
  return convergeNativeHelperOwned({ platform: options.platform, restart: options.restart,
    legacyCaller: options.legacyCaller, env: process.env });
}

async function convergeNativeHelperOwned(
  options: NativeConvergenceOptions = {},
): Promise<number | OlderHelperStarted> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  const kind = options.platform ?? nativeSupervisor(env);
  const home = homeFor(env);
  if (
    env.BEELINE_LIB_DIR &&
    resolve(env.BEELINE_LIB_DIR) !== resolve(home, '.local/lib/beeline') &&
    env.BEELINE_LAB !== '1'
  )
    throw new Error(
      'native service convergence requires the canonical ~/.local install; a custom prefix is an explicit lab only',
    );
  if (!options.run)
    await readFile(resolve(home, '.local/lib/beeline-bootstrap.mjs')).catch(() => {
      throw new Error(
        'independent recovery launcher is missing; retry npx usebeeline@latest update when the published release is reachable',
      );
    });
  return withKernelLock(
    `native-helper:${home}`,
    async () => {
      const execute: NativeRunner = options.run ?? (args =>
        native(kind === 'systemd' ? 'systemctl' : 'launchctl', kind === 'systemd' ? ['--user', ...args] : args, env));
      const run: NativeRunner = (args) => {
        progress(`native ${kind}: ${args.join(' ')}`);
        return execute(args);
      };
      if (kind === 'systemd') {
        const directory = resolve(env.XDG_CONFIG_HOME || resolve(home, '.config'), 'systemd/user');
        const path = resolve(directory, SYSTEMD_HELPER_UNIT_NAME);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await readFile(path, 'utf8').catch(() => '')) !== helperServiceUnit())
          await writeFile(path, helperServiceUnit(), { mode: 0o600 });
        await run(['daemon-reload']);
        const units = new Set<string>();
        for (const args of [
          ['list-unit-files', 'beeline-agent@*.service', '--no-legend', '--no-pager'],
          [
            'list-units',
            '--all',
            'beeline-agent@*.service',
            '--no-legend',
            '--no-pager',
            '--plain',
          ],
        ]) {
          const result = await run(args).catch(
            (error: { code?: unknown; stdout?: string; stderr?: string }) => {
              if (error.code === 1 && !error.stdout && !error.stderr) return { stdout: '' }; // No matching legacy units is a valid old topology.
              throw error;
            },
          );
          for (const line of result.stdout.split('\n')) {
            const columns = line.trim().split(/\s+/);
            const name = columns[0]!;
            if (args[0] === 'list-units' && columns[1] === 'not-found' && columns[2] === 'inactive')
              continue;
            if (/^beeline-agent@[0-9a-f]{64}\.service$/i.test(name)) units.add(name);
          }
        }
        const disableLegacy = async (unit: string) =>
          run(['disable', unit]).catch((error) => {
            if (!/Unit(?: file)? .*does not exist/i.test(String(error))) throw error;
          });
        if (units.size) {
          const legacyStop = resolve(directory, 'beeline-agent@.service.d');
          await mkdir(legacyStop, { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(legacyStop, 'beeline-forward-migration.conf'),
            '[Service]\nTimeoutStopSec=90s\nKillMode=control-group\n',
            { mode: 0o600 },
          );
          await run(['daemon-reload']);
        }
        // A legacy unit cannot synchronously stop its own caller before it
        // gives the native manager the successor job. The new helper retries
        // old PID holders until these jobs release their agents.
        if (options.legacyCaller && units.has(options.legacyCaller)) {
          const ordering = resolve(directory, `${SYSTEMD_HELPER_UNIT_NAME}.d`);
          await mkdir(ordering, { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(ordering, 'legacy-forward-migration.conf'),
            `[Unit]\nConflicts=${[...units].join(' ')}\nAfter=${[...units].join(' ')}\n`,
            { mode: 0o600 },
          );
          await run(['daemon-reload']);
          for (const unit of units) await disableLegacy(unit);
          await run(['enable', SYSTEMD_HELPER_UNIT_NAME]);
          await run(['reset-failed', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
          await run(['start', '--no-block', SYSTEMD_HELPER_UNIT_NAME]);
          return 0; // Compatibility entry exits; the native owner completes convergence.
        }
        for (const unit of units) await disableLegacy(unit);
        if (units.size) await run(['stop', ...units]); // One native job batch; completion proves every old process group stopped.
        await rm(
          resolve(directory, `${SYSTEMD_HELPER_UNIT_NAME}.d/legacy-forward-migration.conf`),
          { force: true },
        );
        await rm(resolve(directory, 'beeline-agent@.service'), { force: true });
        await run(['daemon-reload']);
        await run(['enable', SYSTEMD_HELPER_UNIT_NAME]);
        await run(['reset-failed', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
        // start waits for the native notify job. A timeout never disables its only restart owner.
        await run([options.restart ? 'restart' : 'start', SYSTEMD_HELPER_UNIT_NAME]);
        const state = await run(['show', '--property=MainPID', SYSTEMD_HELPER_UNIT_NAME]);
        const pid = Number(state.stdout.match(/^MainPID=(\d+)$/m)?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error('native helper start completed without a process');
        await run(['reload', SYSTEMD_HELPER_UNIT_NAME]);
        return pid;
      }
      const version = await launchdBundleVersion(env);
      const ready = await startHelperWithAcknowledgment(defaultSupervisorRoot(env), async () => {
        const domain = `gui/${process.getuid!()}`;
        const target = `${domain}/${LAUNCHD_HELPER_LABEL}`;
        const directory = resolve(home, 'Library/LaunchAgents');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await mkdir(resolve(home, 'Library/Logs/Beeline'), { recursive: true, mode: 0o700 });
        const legacy = (await readdir(directory)).filter((entry) =>
          /^app\.usebeeline\.agent\.[0-9a-f]{64}\.plist$/i.test(entry),
        );
        const retire = async () => {
          for (const entry of legacy.sort(
            (a, b) =>
              Number(a === `${options.legacyCaller}.plist`) -
              Number(b === `${options.legacyCaller}.plist`),
          )) {
            if (!/^app\.usebeeline\.agent\.[0-9a-f]{64}\.plist$/i.test(entry)) continue;
            const label = entry.slice(0, -6);
            await run(['disable', `${domain}/${label}`]);
            await run(['bootout', `${domain}/${label}`]).catch((error) => {
              if (!/No such process|Could not find service|failed: 3\b/.test(String(error)))
                throw error;
            });
            await rm(resolve(directory, entry));
          }
        };
        if (!options.legacyCaller) await retire();
        const path = resolve(directory, `${LAUNCHD_HELPER_LABEL}.plist`);
        const changed = (await readFile(path, 'utf8').catch(() => '')) !== nativeHelperPlist(env);
        const before = await run(['print', target]).catch(() => ({ stdout: '' }));
        let pid = launchdJobPid(before.stdout);
        const replace = Boolean(options.restart && pid);
        const bootstrap = !before.stdout || (changed && (!pid || replace));
        if (bootstrap && before.stdout) await run(['bootout', target]);
        await writeFile(path, nativeHelperPlist(env), { mode: 0o600 });
        await rm(resolve(home, 'Library/Application Support/Beeline/bin/supervise-helper'), {
          force: true,
        });
        await run(['enable', target]);
        let started = false;
        if (bootstrap) {
          await run(['bootstrap', domain, path]);
          pid = launchdJobPid((await run(['print', target])).stdout);
          started = true;
        } else if (replace || !pid) {
          const job = await run(['kickstart', ...(replace ? ['-k'] : []), '-p', target]);
          pid = Number(job.stdout.trim());
          started = true;
        }
        if (options.legacyCaller) await retire();
        return { pid, started };
      }, version);
      return 'older' in ready ? ready : ready.pid;
    },
    { step: 'native service convergence' },
  );
}

export async function startNativeHelper(
  env: NodeJS.ProcessEnv = process.env,
  options: { run?: NativeRunner; platform?: 'systemd' | 'launchd' } = {},
): Promise<void | OlderHelperStarted> {
  const kind = options.platform ?? nativeSupervisor(env);
  assertLifecycleTestIsolation(env, Boolean(options.run));
  progress(`native ${kind}: starting the helper successor`);
  if (kind === 'systemd') {
    if (options.run) await options.run(['start', SYSTEMD_HELPER_UNIT_NAME]);
    else await native('systemctl', ['--user', 'start', SYSTEMD_HELPER_UNIT_NAME], env);
  } else return withKernelLock(`native-helper:${homeFor(env)}`, async () => {
    const version = await launchdBundleVersion(env);
    const ready = await startHelperWithAcknowledgment(defaultSupervisorRoot(env), async () => {
      const target = `gui/${process.getuid!()}/${LAUNCHD_HELPER_LABEL}`;
      const run: NativeRunner = options.run ?? (args => native('launchctl', args, env));
      const before = await run(['print', target]);
      const pid = launchdJobPid(before.stdout);
      if (pid) return { pid, started: false };
      const started = await run(['kickstart', '-p', target]);
      return { pid: Number(started.stdout.trim()), started: true };
    }, version);
    if ('older' in ready) return ready;
  }, { step: 'native service convergence' });
}

/** Local observation only. A native active state is separate from per-agent readiness. */
export async function nativeHelperStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  try {
    const kind = nativeSupervisor(env);
    const args =
      kind === 'systemd'
        ? [
            '--user',
            'show',
            '--property=ActiveState',
            '--property=UnitFileState',
            '--property=MainPID',
            '--property=Result',
            SYSTEMD_HELPER_UNIT_NAME,
          ]
        : ['print', `gui/${process.getuid!()}/${LAUNCHD_HELPER_LABEL}`];
    progress(`reading native ${kind} status`);
    const result = await native(kind === 'systemd' ? 'systemctl' : 'launchctl', args, env);
    if (kind === 'systemd')
      return Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => line.split('=', 2)),
      );
    return {
      state: result.stdout.match(/^\s*state\s*=\s*(.+)$/m)?.[1] ?? 'loaded',
      pid: result.stdout.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1] ?? '0',
    };
  } catch (error) {
    return { state: 'unavailable', error: String(error) };
  }
}
