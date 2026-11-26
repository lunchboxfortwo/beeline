import { withCallerSignal } from './owner-link.js';
import { convergeDependencies } from './recovery-dependencies.js';
import { progress } from './update-progress.js';
import { convergeMachine, prepareMachineRelease } from './recovery.js';
/**
 * `beeline update` — the on-demand half of the daemon self-update path.
 *
 * Downloads and verifies the published bundle. A serving helper activates it
 * and restarts through its service manager in a quiet gap between turns.
 * With no helper running, native convergence starts it and awaits the selected release.
 */
import pc from 'picocolors';
import type { AdapterUpdateOptions } from './adapter-update.js';
import {
  installLatestAgentAdapter,
  latestAdapterInstallCommand,
  type AgentKind,
} from './agent-command.js';
import { helperStatusLines } from './helper-status.js';
import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  readRuntimeRecord,
} from './runtime.js';
import {
  activeReleaseId,
  archiveUrlFor,
  beelineInstallLayout,
  describeIdentity,
  discoveredBeelineInstallLayout,
  hostPlatformKey,
  fetchText,
  installedReleaseChannel,
  readInstalledBundleIdentity,
  readUpdateState,
  updateCommandManifestUrl,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  compareBundleIdentity,
  parseUpdateManifest,
} from './self-update-manifest.js';

interface RuntimeAdapterRefreshOptions extends AdapterUpdateOptions {
  env?: NodeJS.ProcessEnv;
  configPaths?: string[];
  readRuntime?: (path: string) => Promise<{ agentKind?: AgentKind }>;
  log?: (line: string) => void;
}

/**
 * Refresh each separable adapter once, no matter how many Room agents share
 * it. `beeline start` already enters through `runUpdateCommand`, so the same
 * pass covers direct `npx usebeeline update` and the whole start fan-out.
 */
export async function refreshRuntimeHarnessAdapters(
  options: RuntimeAdapterRefreshOptions = {},
): Promise<void> {
  return withCallerSignal(async (signal) => {
    signal.throwIfAborted();
    const log = options.log ?? console.log;
    const readRuntime = options.readRuntime ?? readRuntimeRecord;
    const configPaths = options.configPaths ?? [
      ...(await findRuntimeConfigPaths(process.cwd()).catch(() => [] as string[])),
      ...(await findAgentRuntimeConfigPaths(process.env, process.cwd()).catch(
        () => [] as string[],
      )),
    ];
    const kinds = new Set<AgentKind>();
    for (const path of new Set(configPaths)) {
      const runtime = await readRuntime(path).catch(() => undefined);
      if (runtime?.agentKind) kinds.add(runtime.agentKind);
    }
    for (const kind of kinds) {
      if (!latestAdapterInstallCommand(kind)) continue;
      // updateAgentAdapter logs its real decision: current, or the exact prefix install.
      try {
        await installLatestAgentAdapter(kind, { ...options, log, signal });
        signal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        log(
          `[beeline] ${kind} adapter refresh failed; keeping the installed copy (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }, options.signal);
}

function updateUsage(): void {
  console.log(`
${pc.bold('Update the installed Beeline bundle from the published manifest.')}

${pc.dim('Usage:')}
  beeline update                     Check, download, verify, and apply;
                                     running daemons restart onto it once idle
  beeline update --check             Report only — no download, no swap
  beeline update --status            Show installed identity, releases, and state
  beeline update --force             Apply even when the comparison is indeterminate
  beeline update --manifest-url <u>  Override the published manifest URL

The supervised helper checks the manifest on connection and on release notices,
then waits for a quiet gap to restart.
`);
}

/**
 * Almost always the installed wrapper already exported BEELINE_LIB_DIR. The
 * one case it hasn't is `npx usebeeline update`: npx runs the CLI from a
 * throwaway npm cache, never through `<prefix>/bin/beeline`, so there is no
 * layout in the environment at all. Rather than refuse outright, locate the
 * installed bundle the way the installer laid it out
 * (`discoveredBeelineInstallLayout`) and delegate the update to IT — the
 * same install `beeline update` would have found. Only when no bundle
 * actually exists there does this still refuse, with the useful next step
 * instead of an installer-layout error that means nothing to an `npx` caller.
 */
export async function requireLayout(): Promise<BeelineInstallLayout> {
  const layout = beelineInstallLayout(process.env);
  if (layout) return layout;
  const discovered = discoveredBeelineInstallLayout(process.env);
  if ((await readInstalledBundleIdentity(discovered)) !== undefined) return discovered;
  throw new Error('this host has no Beeline install; run `npx usebeeline connect` first.');
}

async function printStatus(layout: BeelineInstallLayout): Promise<void> {
  const [helper, ...agents] = await helperStatusLines();
  console.log(`${pc.bold('helper')}            ${helper}`);
  for (const line of agents) console.log(`  ${line}`);
  const installed = await readInstalledBundleIdentity(layout);
  const active = await activeReleaseId(layout);
  const state = await readUpdateState(layout);
  console.log(`${pc.bold('installed bundle')}  ${describeIdentity(installed)}`);
  console.log(`${pc.bold('active release')}    ${active ?? 'none (legacy layout, never updated)'}`);
  console.log(`${pc.bold('release channel')}   ${await installedReleaseChannel(layout)}`);
  if (state.lastCheckAt) {
    console.log(
      `${pc.bold('last check')}         ${new Date(state.lastCheckAt).toISOString()} — ${state.lastCheckResult ?? 'unknown'}`,
    );
  }
}

export async function runUpdateCommand(args: string[], signal?: AbortSignal): Promise<void> {
  return withCallerSignal(async (signal) => {
    signal.throwIfAborted();
    if (args.includes('--help') || args.includes('-h')) {
      updateUsage();
      return;
    }

    const supported = new Set(['update', '--check', '--status', '--force', '--manifest-url']);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (!supported.has(arg)) throw new Error(`unknown update argument: ${arg}`);
      if (arg === '--manifest-url') {
        if (!args[++index]) throw new Error('--manifest-url requires a URL');
      }
    }

    const layout = await requireLayout();
    if (args.includes('--status')) {
      await printStatus(layout);
      return;
    }

    const manifestUrlFlag = args.indexOf('--manifest-url');
    const checkOnly = args.includes('--check');
    const force = args.includes('--force');
    const manifestUrl = await updateCommandManifestUrl(
      layout,
      manifestUrlFlag >= 0 ? args[manifestUrlFlag + 1] : undefined,
      args.includes('update') && !checkOnly,
    );
    const installed = await readInstalledBundleIdentity(layout);
    console.log(`[beeline] installed bundle: ${describeIdentity(installed)}`);

    if (checkOnly) {
      const raw = await fetchText(manifestUrl, fetch);
      const { bundle } = parseUpdateManifest(raw, hostPlatformKey());
      const verdict = compareBundleIdentity(installed, bundle);
      if (verdict.kind === 'update-available') {
        console.log(
          `[beeline] update available: ${describeIdentity({ commit: bundle.commit, version: bundle.version })}`,
        );
        console.log(`[beeline] archive: ${archiveUrlFor(manifestUrl, bundle.file)}`);
      } else
        console.log(
          `[beeline] ${verdict.kind === 'current' ? 'installed bundle is current.' : `cannot compare: ${verdict.reason}`}`,
        );
      return;
    }
    let target: Awaited<ReturnType<typeof prepareMachineRelease>>;
    try {
      target = await prepareMachineRelease(layout, {
        env: {
          ...process.env,
          BEELINE_LIB_DIR: layout.libDir,
          BEELINE_UPDATE_MANIFEST_URL: manifestUrl,
        },
        force,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      await convergeMachine({ layout, reportAgentsOnly: true });
      throw new Error(
        `helper recovered on the verified installed release; freshness unconfirmed: ${String(error)}`,
      );
    }
    await convergeDependencies(layout, target.releaseId, undefined, signal);
    signal.throwIfAborted();
    const status = await convergeMachine({
      layout,
      env: { ...process.env, BEELINE_LIB_DIR: layout.libDir },
      releaseId: target.releaseId,
      reportAgentsOnly: true,
      force,
    });
    for (const [id, agent] of Object.entries(status.agents))
      progress(
        `agent ${id}: ${agent.state} since ${agent.since}; ${agent.lastError ?? agent.status}; snapshot ${status.updatedAt}`,
      );
    console.log(
      `[beeline] executing release ${status.loadedRelease}; helper pid ${status.pid} ${status.processState}`,
    );
  }, signal);
}
