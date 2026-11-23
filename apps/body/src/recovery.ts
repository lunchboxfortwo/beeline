import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { askMachine, followHelperExit, helperAbsent, type MachineAnswer } from './machine-control.js';
import {
  convergeNativeHelper,
  nativeHelperStatus,
  nativeSupervisor,
  startNativeHelper,
  SYSTEMD_HELPER_UNIT_NAME,
  type NativeRunner,
} from './native-helper.js';
import { prepareReleaseInWorker, versionAtLeast, withInstallLock } from './managed-update.js';
import {
  activeReleaseId,
  activateRelease,
  discoveredBeelineInstallLayout,
  beelineInstallLayout,
  prepareLatestRelease,
  readUpdateState,
  writeUpdateState,
  readInstalledBundleIdentity,
  resolveBundleEntrypoint,
  type BeelineInstallLayout,
} from './self-update.js';
import { runtimeConfigPath } from './runtime.js';
import { progress } from './update-progress.js';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';

export async function prepareMachineRelease(
  layout: BeelineInstallLayout,
  options: Parameters<typeof prepareLatestRelease>[1] = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...(options?.env ?? process.env),
    BEELINE_LIB_DIR: layout.libDir,
  };
  if (options?.fetchImpl || env.BEELINE_LAB === '1')
    return withInstallLock(layout, () => prepareLatestRelease(layout, options), 'release preparation');
  const stable = resolve(layout.libDir, '../beeline-bootstrap.mjs');
  const entrypoint =
    env.BEELINE_RECOVERY_ENTRY ||
    (await readFile(stable).then(
      () => stable,
      () => process.argv[1],
    ));
  return prepareReleaseInWorker(
    { ...env, ...(options?.force ? { BEELINE_FORCE_REPAIR: '1' } : {}) },
    entrypoint,
    options?.signal,
  );
}

/**
 * Every mutating entry converges service even when verified content is reused.
 * It asks the helper once and reports what the helper answered: the selected
 * release and each agent's current state. It never waits for agents to serve.
 */
export async function convergeMachine(
  options: {
    env?: NodeJS.ProcessEnv;
    layout?: BeelineInstallLayout;
    releaseId?: string;
    force?: boolean;
    run?: NativeRunner;
    agentIds?: string[];
    /** Update reports agents as a snapshot; start and pairing refuse agents that cannot serve. */
    reportAgentsOnly?: boolean;
  } = {},
): Promise<MachineAnswer> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  const layout = options.layout ?? beelineInstallLayout(env) ?? discoveredBeelineInstallLayout(env);
  const stateRoot = env.XDG_STATE_HOME || resolve(env.HOME || '', '.local/state');
  const current = await askMachine(stateRoot, { operation: 'status' }).catch(
    error => { if (helperAbsent(error)) return undefined; throw error; },
  );
  const hasControl = Boolean(current);
  // Repair current-release anchors and forwarders even while its body is live.
  // A different prepared release is handed off by the serving helper.
  if (options.releaseId && (!hasControl || current?.loadedRelease === options.releaseId))
    await withInstallLock(layout, () => activateRelease(layout, options.releaseId!), 'release activation');
  // A live helper can pick up one paired runtime directly. Avoid rewriting its
  // native service from a potentially older connect bundle.
  if (!hasControl || !options.agentIds) await convergeNativeHelper({
    env: { ...env, BEELINE_LIB_DIR: layout.libDir },
    ...(options.run ? { run: options.run } : {}),
    // A pre-control helper cannot acknowledge this protocol. Its first forward migration replaces it once.
    restart: !hasControl,
  });
  let status: MachineAnswer;
  if (options.releaseId && hasControl) {
    const answer = await askMachine(stateRoot, {
      operation: 'update',
      releaseId: options.releaseId,
      sourceGeneration: current!.generation,
      ...(options.force ? { force: true } : {}),
    });
    // A helper that predates one-answer control answers the snapshot it had and
    // hands off later; it is done only once it already runs the target.
    const legacy = !answer.outcome && answer.loadedRelease !== options.releaseId;
    if (answer.outcome === 'handoff' || legacy) {
      progress(`helper pid ${answer.pid} is handing off to release ${options.releaseId}; following its exit` +
        (legacy ? ' (this helper predates one-answer control; Ctrl-C stops waiting, the helper continues)' : ''));
      await followHelperExit(stateRoot, answer);
      if (options.run) await options.run(['start', SYSTEMD_HELPER_UNIT_NAME]);
      else await startNativeHelper(env);
      status = await askMachine(stateRoot, { operation: 'status' });
      if (status.generation === answer.generation)
        throw new Error(`helper pid ${status.pid} did not hand off to release ${options.releaseId}`);
    } else status = answer;
  } else status = await askMachine(stateRoot, { operation: 'converge' });
  await checkTarget(status, layout, options.releaseId);
  if (!options.reportAgentsOnly) checkAgents(status, stateRoot, options.agentIds);
  return status;
}

/** The selected target, or a strictly newer successor, must be loaded; the predecessor's desire is not execution. */
async function checkTarget(status: MachineAnswer, layout: BeelineInstallLayout, releaseId?: string): Promise<void> {
  if (!releaseId || status.loadedRelease === releaseId) return;
  const target = await readInstalledBundleIdentity({ ...layout, libDir: resolve(layout.releasesRoot, releaseId) });
  const loaded = status.loadedIdentity?.version;
  if (target?.version && loaded && target.version !== loaded && versionAtLeast(loaded, target.version)) return;
  throw new Error(
    `helper pid ${status.pid} is serving release ${status.loadedRelease ?? 'unknown'}, not ${releaseId}` +
      (status.lastError ? `; last error: ${status.lastError}` : ''),
  );
}

/** Agents are reported as they are now. Only an explicit refusal or an unhosted requested agent fails. */
function checkAgents(status: MachineAnswer, stateRoot: string, agentIds?: string[]): void {
  const required = agentIds ?? [];
  const refused = Object.entries(status.agents).filter(
    ([id, agent]) =>
      (required.includes(id) || (!agentIds && agent.enabled !== false)) &&
      (agent.state === 'needs-auth' || agent.state === 'needs-config' || agent.state === 'removed'),
  );
  const missing = required.filter((id) => !status.agents[id] || status.agents[id]?.enabled === false);
  const problems = [
    ...refused.map(([id, agent]) => `agent ${id}: ${agent.status}`),
    ...missing.map((id) => !status.agents[id] && /^[0-9a-f]{64}$/i.test(id) &&
      !existsSync(runtimeConfigPath(stateRoot, id))
      ? `agent ${id}: removed from this machine`
      : `agent ${id}: not hosted by helper pid ${status.pid}`),
  ];
  if (problems.length) throw new Error(problems.join('; '));
}

/** Native manager starts the independent bootstrap; the selected body never owns freshness at boot. */
export async function bootstrapMachine(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  nativeSupervisor(env);
  const native = await nativeHelperStatus(env);
  const pid = Number(native.MainPID ?? native.pid);
  if (
    !pid ||
    ![Number(env.BEELINE_BOOT_LAUNCHER_PID), Number(env.BEELINE_BOOT_LAUNCHER_PARENT_PID)].includes(
      pid,
    )
  )
    throw new Error('helper bootstrap requires native service ownership; run beeline start');
  const layout = beelineInstallLayout(env) ?? discoveredBeelineInstallLayout(env);
  // The serving predecessor already verified the staged successor. Never put
  // publication/download work on the outage path; MachineLink checks freshness
  // after registration while Room intake is open.
  const state = await readUpdateState(layout);
  const active = await activeReleaseId(layout);
  // Consume a staged boot selection once, before activation can fail. If the
  // native launcher returns to the old anchor, it must not retry that selection.
  if (state.stagedReleaseId) await withInstallLock(layout, async () => {
    const current = await readUpdateState(layout);
    if (current.stagedReleaseId === state.stagedReleaseId)
      await writeUpdateState(layout, { ...current, stagedReleaseId: undefined });
  }, 'helper boot selection');
  let releaseId: string | undefined;
  for (const id of [state.stagedReleaseId, active]) {
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) continue;
    const digest = await readFile(resolve(layout.releasesRoot, id, '.stage-ok'), 'utf8').catch(() => '');
    if (/^[0-9a-f]{64}$/i.test(digest.trim()) &&
        await resolveBundleEntrypoint(resolve(layout.releasesRoot, id))) {
      releaseId = id;
      break;
    }
  }
  if (!releaseId) {
    // Recovery of a missing/broken install still prepares before importing code.
    releaseId = (await prepareMachineRelease(layout, {
      env, logger: line => console.error(line),
    })).releaseId;
  }
  if (releaseId !== active)
    await withInstallLock(layout, () => activateRelease(layout, releaseId!, { deferPruning: true }), 'helper boot activation');
  const entry = await resolveBundleEntrypoint(resolve(layout.releasesRoot, releaseId));
  if (!entry) throw new Error(`selected release ${releaseId} has no body entry`);
  return entry;
}
