import { createUsageRefresh } from './agent-usage-refresh.js';
import { storeVaultSubmission, type VaultSaveSubmission } from './vault-save.js';
import { StdioSquireMcpClient } from './squire-mcp-client.js';
import { executableOnPath, requireInstalledAgentProgram } from './agent-command.js';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadBodyConfig } from './config.js';
import { formatAgentCommand } from './agent-command.js';
import { LEGACY_ACCESS_POLICY } from './access-policy.js';
import { syncAgentModelCatalog } from './model-catalog-sync.js';
import {
  AgentSignIn,
  agentSignInHarness,
  answerAgentSignInFrame,
  reportAgentSignInResult,
} from './agent-sign-in.js';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import { RegistryMcpHostBroker, registryMcpBrokerSocketPath } from './registry-mcp.js';
import { BrowserShareHost, browserShareHostPath } from './browser-share-host.js';
import { AgentRunner } from './agent-runner.js';
import { AgentLifecycle, type AgentExitReason } from './helper-lifecycle.js';
import { migrateLegacyDaemonTransport } from './legacy-daemon-migration.js';
import { activateDaemonTransport, DaemonApiError } from './daemon-api-client.js';
import {
  clearDaemonPidRecordIfPid,
  convergeRuntimeRecordFileModes,
  migrateRuntimeRecordAccessPolicy,
  runtimeAgentCommand,
  writeDaemonPidRecord,
} from './runtime.js';
import { retireRemovedAgent } from './agent-retirement.js';
import { readMachineId } from './connect-command.js';
import type { BeelineInstallLayout } from './self-update.js';
import type { InstalledBundleIdentity } from './self-update-manifest.js';
import { clearDaemonStartFailures } from './daemon-failure.js';
import type { MachineLink } from './machine-link.js';

/** What the machine helper needs from one agent it hosts. */
export interface HostedAgent {
  readonly agentId: string;
  readonly runtimeDir: string;
  readonly lifecycle: AgentLifecycle;
}

/** What one agent runtime needs from the machine helper that hosts it. */
export interface AgentRuntimeHost {
  /** The machine's one socket to this server origin. */
  machineLink(baseUrl: string): MachineLink;
  readonly layout: BeelineInstallLayout | undefined;
  readonly loadedRelease: string | undefined;
  readonly loadedReleaseIdentity: InstalledBundleIdentity | undefined;
  /** Managed free agents validate their pinned model in the real Room session. */
  readonly freeAgent?: boolean;
  /** Join the machine's update drain and forced-update handoff; returns leave. */
  attach(agent: HostedAgent): () => void;
  /** A status line for `beeline update --status`. */
  progress(agentId: string, status: string, fault?: unknown): void;
  /** This agent finished starting (or gave up on it). */
  established(agentId: string): void;
  tickUpdate(): void;
  notifyReleaseAvailable(releaseKey: string): void;
  requestForceUpdate(minVersion: string): void;
}

/**
 * One paired agent inside the machine helper: its runtime record, transport
 * registration, sandbox, Room runtime and workers. It returns why it ended;
 * the machine helper decides whether that restarts this agent, stops it, or
 * restarts the whole helper (an update). It never exits the process.
 */
export async function runAgentRuntime(
  configPath: string,
  host: AgentRuntimeHost,
  signal: AbortSignal,
): Promise<AgentExitReason> {
  const runtimeDir = dirname(configPath);
  // Existing installs converge on the private file modes a fresh runtime
  // record already gets: defense-in-depth alongside the sandbox mask below,
  // for the same-machine case file modes alone can actually help with.
  await convergeRuntimeRecordFileModes(configPath);
  // One-time, idempotent migration: a runtime record that predates per-agent
  // access policies gets an explicit `accessPolicy: 'everyone'` stamped on it,
  // so flipping DEFAULT_ACCESS_POLICY to owner-only never re-gates an
  // already-paired agent. A record with any explicit policy is untouched.
  const accessMigration = await migrateRuntimeRecordAccessPolicy(configPath);
  let runtime = accessMigration.runtime;
  if (!runtime.transport) {
    runtime = await migrateLegacyDaemonTransport(configPath);
  }
  const activated = await activateDaemonTransport(
    configPath,
    fetch,
    host.machineLink(runtime.transport!.baseUrl),
  );
  if (!activated) throw new Error('monolith daemon transport activation failed');
  runtime = activated.runtime;
  const agentId = runtime.agent.publicKey;
  const daemonApi = activated.client;
  const loadedReleaseIdentity = host.loadedReleaseIdentity;
  if (host.layout)
    daemonApi.setHelperIdentity({
      releaseVersion: loadedReleaseIdentity?.version,
      sourceSha: loadedReleaseIdentity?.commit,
    });
  // Startup preflight is already a daemon request. A supported successor
  // must identify itself before it can trip the minimum-version gate.
  daemonApi.setForceUpdateListener((minVersion) => host.requestForceUpdate(minVersion));
  // Keep the Room connected when its program is missing so the next turn can
  // show the install command through the ordinary failure receipt.
  let agentProgramError: string | undefined;
  try { requireInstalledAgentProgram(runtime.agentKind ?? 'reference'); }
  catch (error) { agentProgramError = error instanceof Error ? error.message : String(error); }
  const agent = runtimeAgentCommand(runtime);
  await writeDaemonPidRecord(configPath, process.pid);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUZZ_AGENT_BIN: agent.command,
    BUZZ_DEV_MCP_BIN: runtime.mcpBinary,
  };
  const config = loadBodyConfig({
    workspaceRoot: resolve(runtimeDir, 'workspace'),
    llmEnvFile: runtime.llmEnvFile,
    env,
    agent,
  });
  config.agentProgramError = agentProgramError;
  // Per-agent access policy is a property of the paired runtime, not the
  // process env, so inject it here where both are in hand. The supervisor's
  // per-Room config spread carries it to every Body. A record still carrying
  // no explicit policy at this point can only be pre-policy (the migration
  // above stamps every canonical one), so it keeps the frozen legacy
  // behaviour — never the new pairing default.
  config.accessPolicy = runtime.accessPolicy ?? LEGACY_ACCESS_POLICY;
  config.accessOwnerPubkey = runtime.pairedBy;
  if (runtime.accessAllowlist) config.accessAllowlist = [...runtime.accessAllowlist];
  if (runtime.accessAutoResponse) config.accessAutoResponse = runtime.accessAutoResponse;
  if (runtime.externalMcpCapabilities) {
    config.externalMcpCapabilities = [...runtime.externalMcpCapabilities];
  }
  if (runtime.sharedSkills) config.sharedSkills = [...runtime.sharedSkills];
  // Room/corner activation reads the server selection and exercises the live
  // setter in the session that will use it. A throwaway ACP probe here could
  // wait forever before command intake (including stop/login) even exists.
  config.modelSelection = runtime.modelSelection;
  // Pinned so corner-session git credential helpers (`corner-read-token.ts`)
  // can exec this bundle's CLI against the exact runtime record — no state-home
  // discovery inside the sandbox, where XDG dirs are deliberately relocated.
  config.runtimeConfigPath = configPath;
  // The session tries the installed sandbox. Missing or failed sandboxing
  // uses the conversation's restricted native-tool permission handler.
  config.bwrapPath = runtime.sandbox === 'off' ? undefined : executableOnPath('bwrap');
  // Owner-configured credential masks ride the runtime record; the
  // BEELINE_BODY_SANDBOX_MASK env var is already folded into `config` by
  // loadBodyConfig. Both are unioned at spawn time in Body.sessionSpawnCommand.
  if (runtime.sandboxMaskPaths?.length) {
    config.sandboxMaskPaths = [...(config.sandboxMaskPaths ?? []), ...runtime.sandboxMaskPaths];
  }
  const controller = new AbortController();
  const abortFromHost = () => lifecycle.stop('stopped');
  // This agent's own lifecycle. Its end is a return value, never a process exit.
  const lifecycle = new AgentLifecycle({ controller });
  daemonApi.setAuthorityRefusalListener((fault) => {
    if (!controller.signal.aborted) host.progress(agentId, fault.message, fault);
  });
  signal.addEventListener('abort', abortFromHost, { once: true });
  if (signal.aborted) abortFromHost();

  if (host.layout) {
    config.daemonReleaseVersion = loadedReleaseIdentity?.version;
    config.daemonSourceSha = loadedReleaseIdentity?.commit;
  }

  console.log(
    `[beeline] agent ${agentId} in workspace ${runtime.communityId} starting with ${runtime.rooms.length} Room binding(s)`,
  );
  console.log(`[body] agent binary: ${formatAgentCommand(agent)}`);

  let discoveryReady = false;
  const markEstablished = () => {
    if (controller.signal.aborted || !discoveryReady || !daemonApi.channel.isOpen()) return;
    host.established(agentId);
    host.progress(agentId, 'machine registered; discovery ready');
  };
  daemonApi.setChannelStateListener((connected, refusal) => {
    if (controller.signal.aborted) return;
    if (connected) markEstablished();
    else if (refusal) {
      const auth = refusal === 'daemon_token_required' || refusal === 'unauthorized';
      host.progress(
        agentId,
        `degraded: machine registration refused: ${refusal}`,
        new DaemonApiError(
          `machine registration refused: ${refusal}`,
          auth ? 401 : 400,
          false,
          refusal,
        ),
      );
    } else host.progress(agentId, 'degraded: machine link reconnecting');
  });
  const refreshUsage = createUsageRefresh({ api: daemonApi, agentId,
    kind: config.agentKind, env: config.agentEnv, free: host.freeAgent });
  daemonApi.setUsageRefreshListener((requestId) => { void refreshUsage(requestId); });
  const savingVaultCards = new Set<string>();
  daemonApi.setVaultSaveListener(frame => {
    if (typeof frame.attemptId !== 'string' || typeof frame.roomId !== 'string' ||
        typeof frame.cardId !== 'string' || !frame.values || typeof frame.values !== 'object' ||
        Array.isArray(frame.values) || savingVaultCards.has(frame.cardId)) return;
    const submission = frame as unknown as VaultSaveSubmission;
    savingVaultCards.add(submission.cardId);
    const client = new StdioSquireMcpClient({ scope: { agentId, roomId: submission.roomId }, log: () => {} });
    void storeVaultSubmission(submission, (tool, args) => client.call(tool, args))
      .then(answer => {
        if (answer.status === 'saved') void daemonApi.refreshMachineVault();
        return daemonApi.answerVaultSave(submission.attemptId, answer);
      })
      .catch(() => {})
      .finally(() => { client.close(); savingVaultCards.delete(submission.cardId); });
  });
  // Join this agent to its plan account now, so it shows its siblings' reads while idle.
  void refreshUsage.attach();
  let connectorLoop: ConnectorAssignmentLoop | undefined;
  let agentSignIn: AgentSignIn | undefined;
  let registryMcpBroker: RegistryMcpHostBroker | undefined;
  let browserShareHost: BrowserShareHost | undefined;
  let catalogRefresh: Promise<void> | undefined;
  let leaveHost: (() => void) | undefined;
  const refreshCatalog = (): Promise<void> => {
    catalogRefresh ??= syncAgentModelCatalog({
      api: daemonApi,
      agent,
      agentEnv: config.agentEnv,
      agentId,
      workspaceId: runtime.communityId,
      runtimeDir,
      ...(runtime.modelSelection ? { runtimeSelection: runtime.modelSelection } : {}),
      force: true,
    })
      .then(() => undefined)
      .finally(() => {
        catalogRefresh = undefined;
      });
    return catalogRefresh;
  };
  let exitReason: AgentExitReason | undefined;
  try {
    registryMcpBroker = new RegistryMcpHostBroker(
      config.operatorHome,
      fetch,
      // The one per-call gate a Registry route has: the server's existing
      // requester-aware resource approval, asked here because the broker
      // socket — not the harness MCP client — is what every caller reaches.
      async ({ roomId, requestId, target, consume, operation }) =>
        (
          await daemonApi.execute('authorizeResourceCall', {
            roomId,
            requestId,
            target,
            consume,
            ...(operation ? { operation } : {}),
          })
        ).allowed === true,
      // One broker per hosted agent: each authorizes against its own agent.
      registryMcpBrokerSocketPath(config.operatorHome, agentId),
    );
    config.registryMcpBrokerSocket = registryMcpBroker.socketPath;
    void registryMcpBroker.start().catch(error => console.warn('[body] Registry tools unavailable:', error));
    browserShareHost = new BrowserShareHost(
      browserShareHostPath(process.env.XDG_STATE_HOME ?? config.operatorHome ?? homedir(), agentId),
    );
    config.browserShareHostSocket = browserShareHost.socketPath;
    void browserShareHost.start().catch(error => console.warn('[body] Browser sharing unavailable:', error));
    const core = new AgentRunner(runtime, configPath, config, {
      daemonApi,
      onConfigChanged: refreshCatalog,
    });
    leaveHost = host.attach({ agentId, runtimeDir, lifecycle });
    daemonApi.setForceUpdateListener((minVersion) => host.requestForceUpdate(minVersion));
    daemonApi.setHelperReleaseListener(({ version, sha }) => {
      host.notifyReleaseAvailable(`${version}:${sha}`);
      host.tickUpdate();
    });
    const result = await core.run({
      signal: controller.signal,
      onEstablished: () => {
        discoveryReady = true;
        markEstablished();
        void clearDaemonStartFailures(runtimeDir)
          .catch(error => console.warn('[body] startup diagnostics not cleared:', error));
        // One independent harness probe per activation keeps the phone's MODEL /
        // EFFORT rows current; it never blocks readiness or the Room loop.
        void syncAgentModelCatalog({
          api: daemonApi,
          agent,
          agentEnv: config.agentEnv,
          agentId,
          workspaceId: runtime.communityId,
          runtimeDir,
          ...(runtime.modelSelection ? { runtimeSelection: runtime.modelSelection } : {}),
        });
        // Report the machine identity once per activation so the server can
        // collapse multiple agents on one physical host into one machine row
        // in readWorkbench. Best-effort: a failed report does not block
        // readiness or the Room loop.
        // The connector work queue drains on the live Connect push.
        // One loop per agent also handles reconnects.
        connectorLoop ??= new ConnectorAssignmentLoop({
          api: daemonApi,
          agentId,
          registryHome: config.operatorHome,
          refreshVault: () => daemonApi.refreshMachineVault(),
          log: (message) => console.log(`[body] connector: ${message}`),
        });
        daemonApi.setConnectorAssignmentListener(() => connectorLoop?.wake());
        void readMachineId(process.env)
          .then(({ machineId, machineName }) =>
            daemonApi.execute('postAgentMachineReport', { machineId, machineName }))
          .catch((error) => console.warn('[body] machine report failed:', error))
          .finally(() => connectorLoop?.start());
        // `@agent /login`: the owner's Room card relays each step over the
        // live socket; the login lands where this harness reads it.
        const signInHarness = agentSignInHarness(agent.kind);
        if (signInHarness) {
          const cards = new Map<string, string>();
          const log = (message: string) => console.log(`[body] ${message}`);
          agentSignIn ??= new AgentSignIn({
            harness: signInHarness,
            operatorHome: config.operatorHome ?? homedir(),
            agentEnv: config.agentEnv,
            ...(runtime.llmEnvFile ? { llmEnvFile: runtime.llmEnvFile } : {}),
            model: () => config.modelSelection?.model ?? runtime.modelSelection?.model,
            onResult: (attemptId, result) =>
              void reportAgentSignInResult(daemonApi, agentId, attemptId, cards, result, log),
            onSignedIn: () => daemonApi.emitConfigChanged(),
          });
          const signIn = agentSignIn;
          daemonApi.setAgentSignInListener((frame) => {
            void answerAgentSignInFrame(daemonApi, agentId, signIn, frame, cards, log);
          });
        }
      },
      onProgress: (status, fault) => {
        if (!controller.signal.aborted)
          host.progress(
            agentId,
            daemonApi.channel.isOpen() ? status : 'degraded: machine link reconnecting',
            fault,
          );
        host.tickUpdate();
      },
    });
    if (result === 'agent-removed') {
      controller.abort();
      exitReason = 'agent-removed';

    }
  } finally {
    signal.removeEventListener('abort', abortFromHost);
    leaveHost?.();
    connectorLoop?.stop();
    agentSignIn?.stop();
    await registryMcpBroker?.stop();
    await browserShareHost?.stop();
    daemonApi.closeLive();
    // Only clear the pid record while it still names THIS process.
    await clearDaemonPidRecordIfPid(configPath, process.pid);
  }
  if (exitReason === 'agent-removed') {
    await retireRemovedAgent(runtime);
    console.log(`[beeline] agent ${agentId} removed; private storage reclaimed or deferred while in use`);
  }
  return exitReason ?? lifecycle.stopReason ?? 'stopped';
}
