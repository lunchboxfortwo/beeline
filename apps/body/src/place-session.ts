import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentCommand, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { AcpClient, openAcpConversation, type McpServerWire, type PromptResult, type ToolCallEntry } from './acp.js';
import { agentTurnSteps } from './acp.js';
import { agentBehavior } from './agent-command.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { agentGitIdentityEnv } from './agent-git-identity.js';
import { grantedSquireHostBindPaths, harnessStateDirsFromEnv, hostImportedMcpDeclarations, hostImportedMcpServerNames, prepareRoomAgentHome, repairRoomAgentCredentialLinks, watchRoomClaudeLogin, writeBackRoomClaudeLogin } from './agent-home.js';
import { HostPlaces, startAgentProcess, stopAgentProcess } from './agent-process.js';
import { credentialMaskPaths, harnessHomeStateDirs, sandboxMountPlan, siblingAgentMaskPaths, wrapAgentCommand, type SandboxSessionSpec } from './bwrap-sandbox.js';
import { codegraphMcpServer } from './codegraph.js';
import { bodyAgentCommand, type BodyConfig } from './config.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { harnessIdentityLabel, sessionNewMcpServers } from './cursor-acp-bridge.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { GrantRunnerEndpoint, GrantRunnerRoom } from './grant-runner.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { harnessEnforcement, roomShellCapability } from './harness-capabilities.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
import { grantedHostRouteWires, grantedSquireHostRoute, ungatedHostServers } from './host-mcp-route.js';
import { machineHost } from './machine-host.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { agentArgsWithModelSelection, applyAgentModelSelection, filterAllowedModelConfigOptions, parseAdvertisedConfigOptions } from './model-config.js';
import { agentOpenRouterKey } from './openrouter-key-usage.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { installOwnedModelProvider } from './owned-model-install.js';
import { OwnedModelFiles } from './owned-model-files.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { itemPrompt } from './place-prompt.js';
import { assembleSessionPrompt, cornerHasRepositoryWork } from './prompt-assembly.js';
import { registryMcpHostBindPaths, registryMcpHostDeclarations } from './registry-mcp.js';
import { roomPermissionDecision, unsandboxedPermissionDecision } from './room-permissions.js';
import { beelineAgentMcpServer, readOnlyMcpServer, recordSessionModelFallback, sessionGrantedResources, writeSessionResourceAuth } from './room-session.js';
import { roomReplySteps } from './room-turn-steps.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeDirectory } from './runtime.js';
import { durableReplyText, AgentTurnStream } from './turn-stream.js';
import { WarmTranscript } from './warm-transcript.js';
import { cornerCheckoutFolders } from './workspace-checkout.js';
import { SquireTaskRelay } from './squire-task-relay.js';

type Configuration = DaemonOperationMap['getAgentConfiguration']['output'];
type Roster = DaemonOperationMap['getWorkspaceRoster']['output'];

export interface PlaceSessionOptions {
  agent: { publicKey: string; name: string };
  runtime: AgentRuntimeRecord;
  /** This place's config: its private folder and agent home. */
  config: BodyConfig;
  api: DaemonApiClient;
  placeId: string;
  /** Set for a corner. */
  parentRoomId?: string;
  workspaceId: string;
  grantRunner?: GrantRunnerEndpoint;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** The harness exited on its own. */
  onExit(): void;
}

export interface Answer {
  readonly text: string;
  readonly steps: NonNullable<DaemonOperationMap['postRoomMessage']['input']['steps']>;
  readonly stopReason: string;
  readonly toolCalls: readonly ToolCallEntry[];
  /** Remove the live draft; called once the answer is posted. */
  readonly clearDraft: () => Promise<void>;
}

/**
 * One live harness conversation for one place (Room, DM or corner) of one
 * agent. Starting it reads optional context and prepares optional helpers;
 * every one of those that fails becomes a note the agent is shown. Only a
 * harness that cannot start at all leaves the item waiting in its queue.
 */
export class PlaceSession {
  client?: AcpClient;
  sessionId?: string;
  /** Mounts or configuration changed; start fresh before the next item. */
  stale = false;
  private notes: string[] = [];
  private turnPrefix = '';
  private names = new Map<string, string>();
  private readonly warm: WarmTranscript;
  private readonly squireRelay: SquireTaskRelay;
  /** The item being answered, for run_granted_command. */
  current?: AgentCommand;
  private scratch?: string;
  private claudeLoginWatch?: { close(): void };
  private stopping = false;
  readonly contextPath: string;

  constructor(readonly options: PlaceSessionOptions) {
    const root = options.config.workspaceRoot ?? resolve(options.runtime.supervisorRoot, 'places', options.placeId);
    this.contextPath = resolve(root, 'turn-context.json');
    this.warm = new WarmTranscript({ path: resolve(root, 'agent-home', 'warm-transcript.json') });
    const api = options.api;
    const roomId = options.placeId;
    const logged = (label: string) => (error: unknown) => console.error(`[body] ${label}:`, error);
    this.squireRelay = new SquireTaskRelay(options.agent.publicKey, roomId, this.contextPath,
      async call => (await api.execute('authorizeResourceCall', {
        roomId: call.roomId, requestId: call.requestId, target: 'squire',
        ...resourceCallFacts({ method: 'tools/call', params: { name: call.tool } }),
      })).allowed === true,
      options.config.operatorHome ?? homedir(),
      undefined,
      decision => { void api.execute('postSquireApprovalDecision', { roomId, ...decision }).catch(logged('Squire approval decision not published')); },
      sessionId => { void api.execute('endComputerSession', { roomId, sessionId }).catch(logged('Squire session end not published')); },
      async lease => (await api.execute('refreshComputerSession', { roomId, ...lease })).live,
      (url, siteUrl) => { void api.execute('forgetSquireSignIn', { url, ...(siteUrl ? { siteUrl } : {}) }).catch(logged('Squire sign-in removal failed')); },
      async service => (await api.execute('readAgentWorkbench', { roomId })).apps?.find(app =>
        app.appKey === service.trim().toLowerCase() && app.transport === 'squire-api' && app.status === 'connected')?.connectionReference,
      () => api.refreshMachineVault(),
    );
  }

  /** What run_granted_command needs from this place. */
  grantPlace(): GrantRunnerRoom {
    const { config, parentRoomId, workspaceId } = this.options;
    return {
      workspaceId,
      cwd: this.folder(),
      writePolicy: () => parentRoomId
        ? { surface: 'corner', ...(this.scratch ? { scratch: this.scratch } : {}) }
        : {
            surface: 'room', operatorHome: config.operatorHome ?? homedir(),
            ...(config.bwrapPath ? { bwrapPath: config.bwrapPath } : {}),
            ...(this.scratch ? { scratch: this.scratch } : {}),
            harnessStateDirs: [config.agentHomeRoot, config.agentPrivateRoot].filter((path): path is string => Boolean(path)),
            maskPaths: credentialMaskPaths(config.sandboxMaskPaths, config.operatorHome ?? homedir()),
          },
      turn: () => this.current ? { requestId: this.current.turnRequestId, requester: { pubkey: this.current.source.authorId } } : undefined,
    };
  }

  get alive(): boolean { return this.client?.isAlive === true && Boolean(this.sessionId); }

  /** The folder this session works in, writable inside its sandbox. */
  folder(): string {
    const { config, runtime, placeId, parentRoomId, agent } = this.options;
    if (parentRoomId) return cornerCheckoutFolders(runtime.supervisorRoot, placeId, agent.publicKey).path;
    return config.workspaceRoot!;
  }

  private async optional<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try { return await read(); }
    catch (error) {
      this.notes.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }

  /** Bind the tools to the item this session is answering. */
  writeContext(item: AgentCommand | undefined, queued: readonly AgentCommand[], ownedModelDirectory?: string): Promise<void> {
    return writeTurnContext(this.contextPath, item, queued, ownedModelDirectory);
  }

  /** A free agent's hosted model is reachable only with a credential bound to this item. */
  private async hostedModel(item: AgentCommand): Promise<OwnedModelFiles | undefined> {
    const env = this.options.config.agentEnv;
    if (!env?.BEELINE_FREE_AGENT_ID && !env?.BEELINE_FREE_AGENT_MODEL_TOKEN) return undefined;
    const { modelCredential } = await this.options.api.execute('getModelCredential', { roomId: item.roomId, requestId: item.turnRequestId });
    if (!modelCredential) return undefined;
    return OwnedModelFiles.create({
      root: resolve(dirname(this.contextPath), 'state', `owned-model-${item.id}`), credential: modelCredential,
      binding: { agentId: this.options.agent.publicKey, itemId: item.id, provider: 'beeline', model: 'server-selected',
        baseUrl: new URL('/v1/free-agents/model', this.options.api.baseUrl).href },
    });
  }

  /** Make sure a live session serves this place; reuse the running one. */
  async start(): Promise<void> {
    if (this.alive && !this.stale) await this.repairCredentialLinks();
    else await this.startFresh();
  }

  private async repairCredentialLinks(): Promise<void> {
    const { config } = this.options;
    if (config.agentHomeRoot) await repairRoomAgentCredentialLinks({
      root: config.agentHomeRoot, operatorHome: config.operatorHome,
      writeBackNewerClaudeLogin: agentBehavior(config.agentKind).sharedLoginWriteBack === true,
    }).catch(error => console.warn('[body] credential link repair skipped:', error));
  }

  private async startFresh(): Promise<void> {
    await this.stop();
    this.stale = false;
    this.notes = [];
    const sandbox = Boolean(this.options.config.bwrapPath);
    const failure = await this.activate(sandbox).then(() => undefined, (error: unknown) => error ?? new Error('activation failed'));
    // Sandbox wall: when it cannot start, the session still runs with writes
    // refused outside this place's folder, and the agent is told so.
    if (failure && sandbox) {
      await this.stop();
      this.notes.push(`The OS sandbox could not start (${failure instanceof Error ? failure.message : String(failure)}). ` +
        `This session runs without it: you can read files, edit files only inside ${this.folder()}, and shell commands are refused.`);
      await this.activate(false);
    } else if (failure) throw failure;
  }

  private async activate(sandboxed: boolean): Promise<void> {
    const { config, api, agent, runtime, placeId, parentRoomId, workspaceId } = this.options;
    if (config.agentProgramError) throw new Error(config.agentProgramError);
    const corner = Boolean(parentRoomId);
    const folder = this.folder();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const gitCommonDir = corner ? cornerCheckoutFolders(runtime.supervisorRoot, placeId, agent.publicKey).gitCommonDir : undefined;
    if (gitCommonDir) await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
    const [configuration, roster, grants, repository, restore] = await Promise.all([
      this.optional<Configuration | undefined>('Agent configuration', () =>
        api.execute('getAgentConfiguration', { agentId: agent.publicKey, roomId: placeId }), undefined),
      this.optional<Roster | undefined>('Member list', () =>
        api.execute('getWorkspaceRoster', { agentId: agent.publicKey, workspaceId }), undefined),
      sessionGrantedResources(config, () => api.execute('listAgentGrants', { agentId: agent.publicKey, roomId: placeId })),
      this.optional('Repository state', () => api.execute('getRoomRepositoryState', { roomId: parentRoomId ?? placeId }), undefined),
      corner ? this.optional('Corner state', () => api.execute('getCornerRestoreState', { cornerId: placeId }), undefined) : undefined,
    ]);
    this.names = new Map((roster?.members ?? []).map(member => [member.identityId, member.name]));
    const self = roster?.members.find(member => member.identityId === agent.publicKey);
    const selection = {
      model: configuration?.model ?? config.modelSelection?.model,
      effort: configuration?.effort ?? config.modelSelection?.effort,
      fastMode: configuration?.fastMode,
    };
    const operatorHome = config.operatorHome ?? homedir();
    const registryHostDeclarations = registryMcpHostDeclarations(configuration?.registryMcpRoutes, this.contextPath, config.registryMcpBrokerSocket);
    const mountedHostRoutes = [...grants.hostRoutes, ...Object.keys(registryHostDeclarations)];
    const squireScope = {
      agentId: agent.publicKey, roomId: placeId,
      ...(grantedSquireHostRoute(mountedHostRoutes, {
        ...hostImportedMcpDeclarations({ operatorHome, agentKind: config.agentKind }), ...registryHostDeclarations,
      }) ? { relay: await this.squireRelay.listen(this.contextPath) } : {}),
    };
    const resourceAuthFile = await writeSessionResourceAuth(api, this.contextPath);
    const homeOverlay = config.agentHomeRoot ? await prepareRoomAgentHome({
      root: config.agentHomeRoot, squireScope, sharedSkills: config.sharedSkills ?? [],
      isReviewer: configuration?.isReviewer === true, grantedHostRoutes: mountedHostRoutes,
      extraHostRoutes: registryHostDeclarations, resourceAuthFile,
      ...(config.agentKind ? { agentKind: config.agentKind } : {}),
      ...(config.operatorHome ? { operatorHome: config.operatorHome } : {}),
      ...openRouterRoutingInput(config, selection, undefined, {}),
    }) : {};
    const command = bodyAgentCommand(config);
    const harnessLabel = harnessIdentityLabel({ kind: config.agentKind, command });
    const agentEnv: Record<string, string> = {
      ...config.agentEnv, ...homeOverlay,
      ...(corner ? agentGitIdentityEnv(agent) : {}),
      BEELINE_TURN_CONTEXT_FILE: this.contextPath,
    };
    let githubCli: Parameters<typeof assembleSessionPrompt>[0]['githubCli'];
    const featureBranch = restore?.featureBranch ?? `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`;
    const targetBranch = repository?.targetBranch || 'main';
    const repositoryBacked = repository?.resolution === 'repository';
    if (corner && repositoryBacked && config.runtimeConfigPath && config.agentHomeRoot) {
      // GitHub tokens are fetched when git or gh runs, never before delivery.
      await this.optional('GitHub command wrappers', async () => {
        const which = async (name: string) => (await import('./workspace-checkout.js')).execFileAsync('which', [name])
          .then(result => String(result.stdout).trim()).catch(() => undefined);
        const gitBinary = await which('git');
        if (!gitBinary) throw new Error('git is not installed on this machine');
        const ghBinary = await which('gh');
        const launchers = await installCornerGitHubWrappers({
          root: config.agentHomeRoot!, runtimeConfigPath: config.runtimeConfigPath!, roomId: parentRoomId!,
          cliEntrypoint: process.argv[1]!, gitBinary, featureBranch, targetBranch,
          ...(ghBinary ? { ghBinary } : {}),
          inheritedPath: homeOverlay.PATH ?? config.agentEnv.PATH ?? process.env.PATH,
        });
        Object.assign(agentEnv, launchers.env);
        githubCli = launchers.githubCli;
      }, undefined);
    }
    const agentArgs = agentArgsWithModelSelection({ kind: config.agentKind, command, args: config.agentArgs ?? [] }, selection);
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.scratch = tmpDir;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map(dir => mkdir(dir, { recursive: true })));
    const attachScratchRoot = config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    const sandboxSpec: SandboxSessionSpec = {
      operatorHome,
      userRuntimeDir: `/run/user/${process.getuid?.() ?? 0}`,
      grantedPaths: grants.paths,
      mode: corner ? 'edit' : 'readonly',
      cwd: folder,
      ...(corner ? { worktreePath: folder, protectedPaths: [runtime.supervisorRoot] } : {}),
      ...(gitCommonDir ? { gitCommonDir } : {}),
      harnessStateDirs: stateDirs,
      harnessHomeStateDirs: homeStateDirs,
      ...(tmpDir ? { tmpDir } : {}),
      additionalWritablePaths: [
        ...(config.browserShareHostSocket ? [dirname(config.browserShareHostSocket)] : []),
        ...(attachScratchRoot ? [attachScratchRoot] : []),
        ...registryMcpHostBindPaths(configuration?.registryMcpRoutes, config.registryMcpBrokerSocket),
        ...grantedSquireHostBindPaths({ operatorHome, agentKind: config.agentKind, grantedHostRoutes: mountedHostRoutes }),
      ],
      devices: grants.devices,
      maskPaths: [
        ...credentialMaskPaths(config.sandboxMaskPaths, operatorHome),
        ...siblingAgentMaskPaths(runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey)),
      ],
    };
    const spawnCommand = wrapAgentCommand({
      bwrapPath: sandboxed ? config.bwrapPath : undefined, spec: sandboxSpec, command, args: agentArgs,
    });
    const nativeIoProven = harnessEnforcement(harnessLabel).enforcement !== 'unknown';
    const shellCapability = roomShellCapability(harnessLabel, { osSandbox: sandboxed });
    const servers: McpServerWire[] = [
      ...(nativeIoProven && corner || shellCapability === 'runs' ? [] : [readOnlyMcpServer(config, folder, undefined, undefined, agentEnv.PATH)]),
      beelineAgentMcpServer(config, api, {
        roomId: parentRoomId ?? placeId, workspaceId,
        ...(corner ? { cornerId: placeId, repositoryBacked } : {}),
        reviewer: configuration?.isReviewer === true,
        directMessage: repository?.directParticipants?.length === 2,
        nativeIoProven, agentCommand: harnessLabel, attachRoot: folder,
        ...(attachScratchRoot ? { attachScratchRoot } : {}),
        ...(corner && !repositoryBacked ? { cornerScratchRoot: folder } : {}),
        turnContextPath: this.contextPath,
        ...(squireScope.relay ? { squireRelay: squireScope.relay } : {}),
        ...(this.options.grantRunner ? { grantRunner: this.options.grantRunner } : {}),
      }),
    ];
    const codegraph = codegraphMcpServer(config, folder, { readonly: !corner });
    if (codegraph) servers.push(codegraph);
    const hostDeclarations = hostImportedMcpDeclarations({ operatorHome, agentKind: config.agentKind });
    const grantedRouteServers = grantedHostRouteWires(mountedHostRoutes, operatorHome,
      { ...hostDeclarations, ...registryHostDeclarations }, resourceAuthFile, squireScope);
    const sessionServers = sessionNewMcpServers<McpServerWire>(harnessLabel, servers, grantedRouteServers);
    if (agentEnv.BEELINE_FREE_AGENT_ID || agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN)
      await installOwnedModelProvider(agentEnv.PI_CODING_AGENT_DIR);
    await installPiMcpBridge({
      agentCommand: harnessLabel, piHome: agentEnv.PI_CODING_AGENT_DIR,
      piCommand: agentEnv.PI_ACP_PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND,
      agentEnv, servers: [...servers, ...grantedRouteServers],
    });
    const mountedServers = [...servers, ...grantedRouteServers].map(server => server.name);
    const hostServers = ungatedHostServers(
      [...CODE_OWNED_HOST_MCP_NAMES, ...hostImportedMcpServerNames({ operatorHome, agentKind: config.agentKind })],
      mountedHostRoutes);
    const plan = sandboxed ? sandboxMountPlan(sandboxSpec) : undefined;
    const editing = corner && sandboxed;
    const client = (this.options.createAcpClient ?? (value => new AcpClient(value)))({
      agentCommand: spawnCommand.command, harnessCommand: command, agentArgs: spawnCommand.args, agentEnv,
      agentCwd: folder, agentLabel: harnessLabel, backgroundTasks: corner, osSandbox: sandboxed,
      autoApprovePermissions: editing,
      permissionHandler: editing
        ? async () => 'allow'
        : sandboxed
          ? async request => roomPermissionDecision(request, { mountedServers, hostServers, shellSandboxed: true,
            ...(attachScratchRoot ? { attachmentsDir: join(attachScratchRoot, 'attachments') } : {}),
            ...(plan ? { sandboxPlan: plan } : {}), ...(homeOverlay.HOME ? { sandboxHome: homeOverlay.HOME } : {}) })
          : async request => unsandboxedPermissionDecision(request, folder, { mountedServers, hostServers }),
      onUsage: usage => {
        void postChangedAgentUsage(api, agent.publicKey, usage).catch(error => console.error('[agent-usage] publish failed', error));
      },
      onCommands: agentCommandCatalogPublisher({ api, agentId: agent.publicKey, workspaceId }),
    });
    this.client = client;
    HostPlaces.enter(placeId);
    client.on('exit', () => { if (this.client === client && !this.stopping) this.options.onExit(); });
    await startAgentProcess(client);
    if (agentBehavior(config.agentKind).sharedLoginWriteBack && config.agentHomeRoot)
      this.claudeLoginWatch = watchRoomClaudeLogin({ root: config.agentHomeRoot, operatorHome: config.operatorHome });
    const brief = restore?.brief;
    const session = assembleSessionPrompt({
      squireAvailable: Boolean(squireScope.relay),
      surface: corner ? (repositoryBacked ? 'code-corner' : 'repo-less-corner')
        : repository?.directParticipants?.length === 2 ? 'dm' : 'room',
      agentName: self?.name ?? agent.name,
      machineHost: await machineHost(),
      ...(configuration?.soul ? { soul: configuration.soul } : self?.soul ? { soul: self.soul } : {}),
      agentCommand: command,
      ...(brief ? { brief } : {}),
      ...(corner && repositoryBacked ? { worktree: { featureBranch, targetBranch } } : {}),
      ...(!corner && repositoryBacked && repository?.key ? { repository: { name: repository.key, branch: targetBranch } } : {}),
      ...(githubCli ? { githubCli } : {}),
      ...(configuration?.reviewerHandle ? { reviewerHandle: configuration.reviewerHandle } : {}),
      reviewer: configuration?.isReviewer === true,
      cornerPrepareScript: corner && repositoryBacked && cornerHasRepositoryWork(brief),
      ...(sandboxed && !corner && homeOverlay.HOME ? { writableHome: homeOverlay.HOME } : {}),
      ...(shellCapability === 'runs' ? { shell: { available: true } as const }
        : shellCapability === 'refused' ? { shell: { available: false, ...(config.shellUnavailableDetail ? { detail: config.shellUnavailableDetail } : {}) } as const }
          : {}),
    });
    this.turnPrefix = session.turnPrefix;
    if (corner && repositoryBacked)
      this.notes.push(`Your copy of the repository is made by the workspace tool; call it before repository work. It goes in ${folder}.`);
    const fingerprint = JSON.stringify([selection, configuration?.soul ?? self?.soul, command, config.agentArgs, folder, sandboxed]);
    const mode = editing ? 'edit' : 'readonly';
    const opened = await openAcpConversation({
      client, agentCommand: harnessLabel, resumeSessionId: this.warm.resumeSessionId(fingerprint), cwd: folder,
      mcpServers: sessionServers, mode,
      create: () => client.sessionNew({ cwd: folder, mcpServers: sessionServers, mode, systemPrompt: session.systemPrompt }),
      onResumeFailure: error => console.warn('[body] native conversation unavailable; starting cold:', error),
    });
    this.warm.rememberSession(opened.sessionId, fingerprint);
    this.sessionId = opened.sessionId;
    if (selection.model || selection.effort) {
      await this.optional('Model selection', async () => {
        const options = filterAllowedModelConfigOptions(parseAdvertisedConfigOptions(opened.raw, selection.model));
        const applied = await applyAgentModelSelection(client, opened.sessionId, options, selection);
        if (selection.model && applied.appliedSelection.model && applied.appliedSelection.model !== selection.model)
          recordSessionModelFallback(api, agent.publicKey, workspaceId, applied.appliedSelection, applied.options, `place ${placeId}`);
      }, undefined);
    }
    if (agentOpenRouterKey(config.agentKind, selection.model, config.agentEnv))
      console.log(`[body] place ${placeId} uses an OpenRouter key`);
  }

  /**
   * Hand one item to the session and wait for its answer. Throws only when
   * the harness itself fails; the item then stays in the queue.
   */
  async deliver(item: AgentCommand, queued: readonly AgentCommand[]): Promise<Answer> {
    // start() ran first; a session that died since fails its prompt and the item is queued again.
    const client = this.client!;
    const sessionId = this.sessionId!;
    this.current = item;
    if (item.roomId === this.options.placeId) this.squireRelay.activate(item, item.id);
    const model = await this.hostedModel(item);
    await this.writeContext(item, queued, model?.paths().directory);
    const prompt = itemPrompt(item, { names: this.names, notes: this.notes, turnPrefix: this.turnPrefix });
    this.notes = [];
    const stream = new AgentTurnStream({
      api: this.options.api, agentId: this.options.agent.publicKey, roomId: item.roomId,
      requestId: item.turnRequestId, commandId: item.id, label: `place ${item.roomId}`,
    });
    let result: PromptResult;
    try {
      result = await client.sessionPrompt(sessionId, prompt, stream.onChunk);
    } catch (error) {
      void stream.retract();
      throw error;
    } finally {
      stream.close();
      model?.revoke();
      this.squireRelay.deactivate(item.turnRequestId);
      this.current = undefined;
    }
    if (this.options.config.agentHomeRoot && agentBehavior(this.options.config.agentKind).sharedLoginWriteBack)
      void writeBackRoomClaudeLogin({ root: this.options.config.agentHomeRoot, operatorHome: this.options.config.operatorHome })
        .catch(error => console.warn('[body] refreshed Claude login not shared:', error));
    return {
      text: durableReplyText(result.agentText),
      steps: roomReplySteps(agentTurnSteps(result.updates ?? [])),
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      clearDraft: () => stream.retract(),
    };
  }

  /** Stop: end the running prompt now. */
  cancel(): void {
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
  }

  /** The helper is stopping: end the session and its Squire relay. */
  async dispose(): Promise<void> {
    await this.stop();
    this.squireRelay.close();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.claudeLoginWatch?.close();
    this.claudeLoginWatch = undefined;
    if (client) {
      this.stopping = true;
      try { await stopAgentProcess(client); }
      finally { this.stopping = false; HostPlaces.leave(this.options.placeId); }
    }
  }
}

/** The file the agent's tools read to learn which item they serve. */
export async function writeTurnContext(path: string, item: Pick<AgentCommand, 'id' | 'roomId' | 'turnRequestId' | 'rootCommandId' | 'reason'> | undefined,
  queued: readonly Pick<AgentCommand, 'turnRequestId' | 'rootCommandId' | 'reason'>[] = [], ownedModelDirectory?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(item ? {
    roomId: item.roomId, requestId: item.turnRequestId, taskId: item.rootCommandId, commandReason: item.reason, itemId: item.id,
    commands: queued.map(command => ({ requestId: command.turnRequestId, commandReason: command.reason, taskId: command.rootCommandId })),
    startedAt: Date.now(),
    ...(ownedModelDirectory ? { ownedModelDirectory } : {}),
  } : {}), { mode: 0o600 });
}
