#!/usr/bin/env node
import { progress } from './update-progress.js';
import { convergeDependencies } from './recovery-dependencies.js';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrapMachine, convergeMachine, prepareMachineRelease } from './recovery.js';
import {
  discoveredBeelineInstallLayout,
  beelineInstallLayout,
  activeReleaseId,
  readInstalledBundleIdentity,
  readUpdateState,
  resolveBundleEntrypoint,
  hostPlatformKey,
  activateRelease,
  fetchText,
} from './self-update.js';
import {
  resolveManifestUrl,
  parseUpdateManifest,
  compareBundleIdentity,
} from './self-update-manifest.js';
import { askMachine, helperAbsent, type MachineAnswer } from './machine-control.js';
import { runOwned } from './wait.js';
import { exitWithOwner } from './owner-link.js';
import { nativeHelperStatus } from './native-helper.js';
import { runManagedUpdateWorker, withInstallLock } from './managed-update.js';

async function main(): Promise<void> {
  process.env.BEELINE_RECOVERY_ENTRY = process.argv[1];
  const args = process.argv.slice(2);
  const command = args[0];
  // A running coding session joins Beeline without installing the helper.
  if (command === 'join' || command === 'session') {
    const { runSessionCommand } = await import('./session-join/command.js');
    await runSessionCommand(args);
    return;
  }
  const layout = beelineInstallLayout() ?? discoveredBeelineInstallLayout();
  if (command === 'start' && (args.includes('--help') || args.includes('-h'))) {
    console.log(
      'beeline start [--all|--agent <public key>]\nSelect the newest release and converge every enabled agent. --all or --agent re-enables stopped agents.',
    );
    return;
  }
  if (
    (command === 'connect' || !command || command === '--help' || command === '-h') &&
    (args.includes('--help') || args.includes('-h') || !command) &&
    !(await resolveBundleEntrypoint(layout.libDir))
  ) {
    console.log(
      'usebeeline connect — install Beeline and pair an agent\nusebeeline join — join your Beeline chats from a running coding session\nusebeeline update — recover this machine and serve every enabled agent\nusebeeline start [--all|--agent <public key>]\nhttps://usebeeline.app',
    );
    return;
  }
  if (command === 'select-release') {
    console.log(await bootstrapMachine());
    return;
  }
  if (command === 'helper-bootstrap')
    throw new Error('helper-bootstrap must run through the installed native launcher');
  if (command === 'native-converge-worker' || command === 'managed-update-worker') exitWithOwner();
  if (command === 'native-converge-worker') {
    const { runNativeConvergenceWorker } = await import('./native-helper.js');
    console.log(JSON.stringify({ pid: await runNativeConvergenceWorker() }));
    return;
  }
  if (command === 'managed-update-worker') {
    if (process.env.BEELINE_UPDATE_GROUP_OWNER !== '1')
      throw new Error('release worker requires its recovery owner');
    console.log(JSON.stringify(await runManagedUpdateWorker()));
    return;
  }
  if (command === 'update' || command === 'install-only') {
    if (args.includes('--help') || args.includes('-h')) {
      console.log('beeline update [--check|--status|--force] [--manifest-url <url>]');
      return;
    }
    for (let i = 1; i < args.length; i++) {
      if (!['--check', '--status', '--force', '--manifest-url'].includes(args[i]!))
        throw new Error(`unknown update argument: ${args[i]}`);
      if (args[i] === '--manifest-url' && !args[++i])
        throw new Error('--manifest-url requires a URL');
    }
    const stateRoot = process.env.XDG_STATE_HOME || resolve(process.env.HOME || '', '.local/state');
    if (args.includes('--status')) {
      const [native, helper] = await Promise.all([
        nativeHelperStatus(),
        askMachine(stateRoot, { operation: 'status' }).catch(error => {
          if (helperAbsent(error)) return undefined;
          throw error;
        }),
      ]);
      const root = resolve(stateRoot, 'beeline/agents');
      const agents = await Promise.all(
        (await readdir(root).catch(() => []))
          .filter((id) => /^[0-9a-f]{64}$/.test(id))
          .map(async (id) => ({
            agentId: id,
            enabled: !(await stat(resolve(root, id, 'stopped')).then(
              () => true,
              () => false,
            )),
            ...(helper?.agents[id] ?? { state: 'not hosted' }),
            validRecord: await readFile(resolve(root, id, 'runtime.json'), 'utf8')
              .then((raw) => Boolean(JSON.parse(raw).agent))
              .catch(() => false),
          })),
      );
      console.log(
        JSON.stringify(
          {
            native,
            installed: await readInstalledBundleIdentity(layout),
            activeRelease: await activeReleaseId(layout),
            releaseSelection: await readUpdateState(layout),
            helper: helper ?? { state: 'not responding' },
            agents,
          },
          null,
          2,
        ),
      );
      return;
    }
    const index = args.indexOf('--manifest-url');
    const url = index >= 0 ? args[index + 1]! : resolveManifestUrl();
    if (args.includes('--check')) {
      const bundle = parseUpdateManifest(await fetchText(url, fetch), hostPlatformKey()).bundle;
      console.log(compareBundleIdentity(await readInstalledBundleIdentity(layout), bundle));
      return;
    }
    let target: Awaited<ReturnType<typeof prepareMachineRelease>>;
    try {
      target = await prepareMachineRelease(layout, {
        env: { ...process.env, BEELINE_UPDATE_MANIFEST_URL: url },
        force: args.includes('--force'),
      });
    } catch (error) {
      if (command === 'install-only') throw error;
      await convergeMachine({ layout, reportAgentsOnly: true });
      throw new Error(
        `helper recovered on the verified installed release; freshness unconfirmed: ${String(error)}`,
      );
    }
    if (command === 'install-only') {
      if (process.env.BEELINE_LAB !== '1')
        throw new Error('install-only is restricted to an explicit isolated lab');
      const { activateRelease } = await import('./self-update.js');
      const { withInstallLock } = await import('./managed-update.js');
      await withInstallLock(layout, () => activateRelease(layout, target.releaseId));
      console.log('[beeline] verified bundle installed for isolated artifact verification');
      return;
    }
    await convergeDependencies(layout, target.releaseId);
    const status = await convergeMachine({ layout, releaseId: target.releaseId,
      reportAgentsOnly: true, force: args.includes('--force') });
    reportAgents(status);
    console.log(
      `[beeline] executing release ${status.loadedRelease}; helper ${status.pid} ${status.processState}`,
    );
    return;
  }
  const stateRoot = process.env.XDG_STATE_HOME || resolve(process.env.HOME || '', '.local/state');
  if (command === 'start') {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--agent') {
        if (!/^[0-9a-f]{1,64}$/i.test(args[++i] ?? ''))
          throw new Error('--agent requires an agent public key');
      } else if (arg !== '--all' && !(i === 1 && /^[0-9a-f]{1,64}$/i.test(arg)))
        throw new Error(`unknown start argument: ${arg}`);
    }
    const agentFlag = args.indexOf('--agent');
    const requested =
      agentFlag >= 0
        ? args[agentFlag + 1]
        : args[1] && !args[1].startsWith('--')
          ? args[1]
          : undefined;
    if (agentFlag >= 0 && !requested) throw new Error('--agent requires an agent public key');
    const agentRoot = resolve(stateRoot, 'beeline/agents');
    const ids = (await readdir(agentRoot).catch(() => [])).filter((id) =>
      /^[0-9a-f]{64}$/.test(id),
    );
    const selected = requested
      ? ids.filter((id) => id.startsWith(requested))
      : args.includes('--all')
        ? ids
        : [];
    if (requested && selected.length !== 1)
      throw new Error(`no unique paired agent matches ${requested}`);
    for (const id of selected)
      await unlink(resolve(agentRoot, id, 'stopped')).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    let target: Awaited<ReturnType<typeof prepareMachineRelease>>;
    try {
      target = await prepareMachineRelease(layout);
    } catch (error) {
      await convergeMachine({ layout });
      throw new Error(
        `helper recovered on the verified installed release; freshness unconfirmed: ${String(error)}`,
      );
    }
    await convergeDependencies(layout, target.releaseId);
    const status = await convergeMachine({ layout, releaseId: target.releaseId });
    reportAgents(status);
    console.log(
      `[beeline] executing release ${status.loadedRelease}; helper ${status.pid} ${status.processState}`,
    );
    return;
  }
  if (command === 'connect' && !args.includes('--help') && !args.includes('-h') &&
      !(await resolveBundleEntrypoint(layout.libDir))) {
    // Install only on a new machine. Pairing starts/converges the helper after
    // writing the new agent's configuration, without selecting a release.
    const target = await prepareMachineRelease(layout);
    await withInstallLock(layout, () => activateRelease(layout, target.releaseId));
  }
  const entry = await resolveBundleEntrypoint(layout.libDir);
  if (!entry) throw new Error('no installed Beeline body; run npx usebeeline connect');
  const child = await runOwned({
    step: `beeline ${command ?? ''}`.trim(),
    file: process.execPath,
    args: [entry, ...args],
    env: { ...process.env, BEELINE_LIB_DIR: layout.libDir },
    interactive: true,
  });
  process.exitCode = child.code ?? 1;
}

/** The helper's one answer: each agent as it is now. Nothing waits for an agent to serve. */
function reportAgents(status: MachineAnswer): void {
  for (const [id, agent] of Object.entries(status.agents))
    progress(`agent ${id}: ${agent.state} since ${agent.since}; ${agent.lastError ?? agent.status}; snapshot ${status.updatedAt}`);
}
main().catch((error) => {
  console.error(`[beeline] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
