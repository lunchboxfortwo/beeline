import type { AgentCommand,DaemonOperationMap } from '@beeline/api-contract/daemon';
import { mkdir,rm,writeFile } from 'node:fs/promises';
import { homedir,hostname } from 'node:os';
import { delimiter,dirname,join,resolve } from 'node:path';
import { AcpClient,agentTurnSteps,openAcpConversation,type McpServerWire,type PromptResult,type ToolCallEntry } from './acp.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { agentBehavior } from './agent-command.js';
import { agentGitIdentityEnv } from './agent-git-identity.js';
import { harnessStateDirsFromEnv,prepareRoomAgentCredentials,prepareRoomAgentHome,watchRoomClaudeLogin,writeBackRoomClaudeLogin } from './agent-home.js';
import { HostPlaces,startAgentProcess,stopAgentProcess } from './agent-process.js';
import { credentialMaskPaths,harnessHomeStateDirs,sandboxMountPlan,siblingAgentMaskPaths,wrapAgentCommand,type SandboxSessionSpec } from './bwrap-sandbox.js';
import { bodyAgentCommand,type BodyConfig } from './config.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { harnessIdentityLabel,sessionNewMcpServers } from './cursor-acp-bridge.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { GrantRunnerEndpoint,GrantRunnerRoom } from './grant-runner.js';
import { harnessEnforcement,roomShellCapability } from './harness-capabilities.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { agentArgsWithModelSelection,filterAllowedModelConfigOptions,parseAdvertisedConfigOptions } from './model-config.js';
import { agentOpenRouterKey } from './openrouter-key-usage.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { OwnedModelFiles } from './owned-model-files.js';
import { installOwnedModelProvider } from './owned-model-install.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { itemPrompt,offlineBatchPrompt } from './place-prompt.js';
import { assembleSessionPrompt,cornerHasRepositoryWork } from './prompt-assembly.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { roomPermissionDecision,unsandboxedPermissionDecision } from './room-permissions.js';
import { beelineAgentMcpServer,readOnlyMcpServer } from './room-session.js';
import { roomReplySteps } from './room-turn-steps.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeDirectory } from './runtime.js';
import { SessionResources } from './session-resources.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { AgentTurnStream,durableReplyText } from './turn-stream.js';
import { WarmTranscript } from './warm-transcript.js';
import { cornerCheckoutFolders } from './workspace-checkout.js';


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
  grantRunnerFile?: string;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** The harness exited on its own. */
  onExit(): void;
}

export interface Answer {
  readonly text: string;
  readonly followUps?: readonly AgentCommand[];
  readonly steps: NonNullable<DaemonOperationMap['postRoomMessage']['input']['steps']>;
  readonly stopReason: string;
  readonly toolCalls: readonly ToolCallEntry[];
  /** Remove the live draft; called once the answer is posted. */
  readonly cleanup: () => Promise<void>;
}

/**
 * One live harness conversation for one place (Room, DM or corner) of one
 * agent. Optional context and capabilities load after delivery and are read
 * with session tools; startup uses cached facts or disclosed defaults. Only a
 * harness that cannot start at all leaves the item waiting in its queue.
 */
export class PlaceSession {
  client?: AcpClient;
  sessionId?: string;
  /** Configuration changed; start fresh before the next item. */
  stale = false;
  private notes: string[] = [];
  private turnPrefix = '';
  private names = new Map<string, string>();
  private readonly warm: WarmTranscript;
  private readonly squireRelay: SquireTaskRelay;
  /** The item being answered, for run_granted_command. */
  current?: AgentCommand;
  private scratch?: string;
  private privateHomeRoot?: string;
  private claudeLoginWatch?: { close(): void };
  private stopping = false;
  readonly resources: SessionResources;
  private followUps: AgentCommand[] = [];
  readonly contextPath: string;

  constructor(readonly options: PlaceSessionOptions) {
    const root = options.config.workspaceRoot ?? resolve(options.runtime.supervisorRoot, 'places', options.placeId);
    this.contextPath = resolve(root, 'turn-context.json');
    this.resources = new SessionResources({ api: options.api, agentId: options.agent.publicKey,
      placeId: options.placeId, workspaceId: options.workspaceId, parentRoomId: options.parentRoomId,
      cachePath: resolve(root, 'session-context.json'), brokerSocket: options.config.registryMcpBrokerSocket,
      configured: () => this.prepareOptionalHome(),
    });
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
    let files: OwnedModelFiles | undefined;
    if (env?.BEELINE_FREE_AGENT_ID || env?.BEELINE_FREE_AGENT_MODEL_TOKEN) {
      const { modelCredential } = await this.options.api.execute('getModelCredential', { roomId: item.roomId, requestId: item.turnRequestId });
      if (modelCredential) files = await OwnedModelFiles.create({
        root: resolve(dirname(this.contextPath), 'state', `owned-model-${item.id}`), credential: modelCredential,
        binding: { agentId: this.options.agent.publicKey, itemId: item.id, provider: 'beeline', model: 'server-selected',
          baseUrl: new URL('/v1/free-agents/model', this.options.api.baseUrl).href },
      });
    }
    return files;
  }

  /** Make sure a live session serves this place; reuse the running one. */
  async start(): Promise<void> {
    if (!this.alive || this.stale) await this.startFresh();
  }

  private async startFresh(): Promise<void> {
    await this.stop();
    this.stale = false;
    this.notes = [];
    const sandbox = Boolean(this.options.config.bwrapPath);
    if (!sandbox) this.notes.push(`The OS sandbox is unavailable. You can read files, edit files only inside ${this.folder()}, and shell commands are refused.`);
    try { await this.activate(sandbox); }
    catch (error) {
      if (!sandbox) throw error;
      await this.stop();
      this.notes.push(`The OS sandbox could not start (${error instanceof Error ? error.message : String(error)}). ` +
        `This session runs without it: you can read files, edit files only inside ${this.folder()}, and shell commands are refused.`);
      await this.activate(false);
    }
  }

  private async activate(sandboxed: boolean): Promise<void> {
    const { config, api, agent, runtime, placeId, parentRoomId, workspaceId } = this.options;
    const corner = Boolean(parentRoomId);
    const folder = this.folder();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const gitCommonDir = corner ? cornerCheckoutFolders(runtime.supervisorRoot, placeId, agent.publicKey).gitCommonDir : undefined;
    if (gitCommonDir) await mkdir(gitCommonDir, { recursive: true, mode: 0o700 });
    const { configuration, roster, repository, restore } = this.resources.context;
    this.names = new Map((roster?.members ?? []).map(member => [member.identityId, member.name]));
    const self = roster?.members.find(member => member.identityId === agent.publicKey);
    const selection = {
      model: configuration?.model ?? config.modelSelection?.model,
      effort: configuration?.effort ?? config.modelSelection?.effort,
      fastMode: configuration?.fastMode,
    };
    const operatorHome = config.operatorHome ?? homedir();
    const homeOverlay = config.agentHomeRoot ? await prepareRoomAgentCredentials({
      root: config.agentHomeRoot, failClosed: true, agentKind: config.agentKind,
      onDiagnostic: message => this.notes.push(message),
      operatorHome: config.operatorHome,
    }) : {};
    this.privateHomeRoot = homeOverlay.HOME ? dirname(homeOverlay.HOME) : undefined;
    const privateHomeRoot = this.privateHomeRoot;
    const command = bodyAgentCommand(config);
    const harnessLabel = harnessIdentityLabel({ kind: config.agentKind, command });
    const agentEnv: Record<string, string> = {
      ...config.agentEnv, ...homeOverlay,
      ...(corner ? agentGitIdentityEnv(agent) : {}),
      BEELINE_TURN_CONTEXT_FILE: this.contextPath,
    };
    const featureBranch = restore?.featureBranch ?? `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`;
    const targetBranch = repository?.targetBranch || 'main';
    const repositoryBacked = repository?.resolution === 'repository';
    // Cold context loads after delivery; its absence does not mean no repository.
    const repositoryPending = !repository || repository.resolution === 'unverified';
    // The wrapper directory is stable; setup may populate it while the
    // session is already answering. Until then a tool receives its own error.
    if (corner && privateHomeRoot) agentEnv.PATH = [resolve(privateHomeRoot, 'beeline-github-bin'),
      agentEnv.PATH ?? process.env.PATH].filter(Boolean).join(delimiter);
    const knownModels = this.resources.context.modelCatalog?.find(option => option.category === 'model');
    const launchSelection = selection.model && knownModels?.options.some(option => option.id === selection.model) ? selection : selection.model ? {} : undefined;
    const agentArgs = agentArgsWithModelSelection({ kind: config.agentKind, command, args: config.agentArgs ?? [] }, launchSelection);
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.scratch = tmpDir;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map(dir => mkdir(dir, { recursive: true })));
    const attachScratchRoot = homeOverlay.HOME ? dirname(homeOverlay.HOME) : tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    const sandboxSpec: SandboxSessionSpec = {
      operatorHome,
      userRuntimeDir: `/run/user/${process.getuid?.() ?? 0}`,
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
      ],
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
    const inspection = nativeIoProven && corner || shellCapability === 'runs' ? undefined
      : await this.optional('File inspection tools', async () => readOnlyMcpServer(config, folder, undefined, undefined, agentEnv.PATH), undefined);
    const servers: McpServerWire[] = inspection ? [inspection] : [];
    const agentTools = await this.optional('Beeline tools', async () => beelineAgentMcpServer(config, api, {
        roomId: parentRoomId ?? placeId, workspaceId,
        ...(corner ? { cornerId: placeId, repositoryBacked: true } : {}),
        reviewer: configuration?.isReviewer === true,
        directMessage: repository?.directParticipants?.length === 2,
        nativeIoProven, agentCommand: harnessLabel, attachRoot: folder,
        ...(attachScratchRoot ? { attachScratchRoot } : {}),
        ...(corner && !repositoryBacked ? { cornerScratchRoot: folder } : {}),
        turnContextPath: this.contextPath,
        ...(this.options.grantRunner ? { grantRunner: this.options.grantRunner } : {}),
        ...(this.options.grantRunnerFile ? { grantRunnerFile: this.options.grantRunnerFile } : {}),
      }), undefined);
    if (agentTools) servers.push(agentTools);
    const sessionServers = sessionNewMcpServers<McpServerWire>(harnessLabel, servers, []);
    if (agentEnv.BEELINE_FREE_AGENT_ID || agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN)
      await this.optional('Hosted model binding', () => installOwnedModelProvider(agentEnv.PI_CODING_AGENT_DIR), undefined);
    await installPiMcpBridge({
      agentCommand: harnessLabel, piHome: agentEnv.PI_CODING_AGENT_DIR,
      servers,
    });
    const mountedServers = servers.map(server => server.name);
    const hostServers = [...CODE_OWNED_HOST_MCP_NAMES];
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
    if (agentBehavior(config.agentKind).sharedLoginWriteBack && privateHomeRoot)
      this.claudeLoginWatch = watchRoomClaudeLogin({ root: privateHomeRoot, operatorHome: config.operatorHome });
    const brief = restore?.brief;
    const session = assembleSessionPrompt({
      squireAvailable: false,
      surface: corner ? (repository?.resolution === 'none' ? 'repo-less-corner' : 'code-corner')
        : repository?.directParticipants?.length === 2 ? 'dm' : 'room',
      repositoryPending,
      agentName: self?.name ?? agent.name,
      machineHost: { hostname: hostname() },
      ...(configuration?.soul ? { soul: configuration.soul } : self?.soul ? { soul: self.soul } : {}),
      agentCommand: command,
      ...(brief ? { brief } : {}),
      ...(corner && repositoryBacked ? { worktree: { featureBranch, targetBranch } } : {}),
      ...(!corner && repositoryBacked && repository?.key ? { repository: { name: repository.key, branch: targetBranch } } : {}),
      ...(configuration?.reviewerHandle ? { reviewerHandle: configuration.reviewerHandle } : {}),
      reviewer: configuration?.isReviewer === true,
      cornerPrepareScript: corner && repositoryBacked && cornerHasRepositoryWork(brief),
      ...(sandboxed && !corner && homeOverlay.HOME ? { writableHome: homeOverlay.HOME } : {}),
      ...(shellCapability === 'runs' ? { shell: { available: true } as const }
        : shellCapability === 'refused' ? { shell: { available: false, ...(config.shellUnavailableDetail ? { detail: config.shellUnavailableDetail } : {}) } as const }
          : {}),
    });
    this.turnPrefix = session.turnPrefix;
    if (corner && (repositoryBacked || repositoryPending))
      this.notes.push(`Your copy of the repository is made by the workspace tool; call it before repository work. It goes in ${folder}.`);
    // Native resume retains the old system instructions, including repository bans.
    const fingerprint = JSON.stringify([selection, configuration?.soul ?? self?.soul, command, config.agentArgs, folder, sandboxed, session.systemPrompt]);
    const mode = editing ? 'edit' : 'readonly';
    const opened = await openAcpConversation({
      client, agentCommand: harnessLabel, resumeSessionId: this.warm.resumeSessionId(fingerprint), cwd: folder,
      mcpServers: sessionServers, mode,
      create: () => client.sessionNew({ cwd: folder, mcpServers: sessionServers, mode, systemPrompt: session.systemPrompt }),
      onResumeFailure: error => console.warn('[body] native conversation unavailable; starting cold:', error),
    });
    this.warm.rememberSession(opened.sessionId, fingerprint);
    this.sessionId = opened.sessionId;
    const catalog = filterAllowedModelConfigOptions(parseAdvertisedConfigOptions(opened.raw));
    this.resources.rememberModelCatalog(catalog);
    const advertisedDefault = catalog.find(option => option.category === 'model')?.currentValue;
    const runningModel = advertisedDefault ?? 'the agent default';
    if (selection.model && selection.model !== runningModel)
      this.notes.push(`Selected model ${selection.model} is unavailable at startup; this session runs with ${runningModel}.`);
    this.notes.push(`This session uses ${runningModel}; persona and reviewer skills use ${configuration ? 'cached configuration' : 'the agent default'}. Optional context and capability status: read(facet:session).`);
    if (agentOpenRouterKey(config.agentKind, selection.model, config.agentEnv))
      console.log(`[body] place ${placeId} uses an OpenRouter key`);
  }

  private async prepareOptionalHome(): Promise<void> {
    const { config, parentRoomId, placeId } = this.options;
    const homeRoot = this.privateHomeRoot ?? config.agentHomeRoot;
    const configuration = this.resources.context.configuration;
    if (homeRoot) await prepareRoomAgentHome({
      root: homeRoot, failClosed: true, operatorHome: config.operatorHome,
      agentKind: config.agentKind, sharedSkills: config.sharedSkills,
      isReviewer: configuration?.isReviewer === true,
      ...openRouterRoutingInput(config, { model: configuration?.model ?? config.modelSelection?.model }, undefined, {}),
    });
    if (parentRoomId && config.runtimeConfigPath && homeRoot) {
      const { execFileAsync } = await import('./workspace-checkout.js');
      const which = (name: string) => execFileAsync('which', [name]).then(result => String(result.stdout).trim()).catch(() => undefined);
      const gitBinary = await which('git');
      if (!gitBinary) throw new Error('git is not installed');
      await installCornerGitHubWrappers({ root: homeRoot, runtimeConfigPath: config.runtimeConfigPath,
        roomId: parentRoomId, cliEntrypoint: process.argv[1]!, gitBinary, ghBinary: await which('gh'),
        featureBranch: this.resources.context.restore?.featureBranch ?? `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`,
        targetBranch: this.resources.context.repository?.targetBranch || 'main',
        inheritedPath: config.agentEnv.PATH ?? process.env.PATH,
      });
    }
  }

  /** New input joins the active prompt; unsupported steering leaves it queued. */
  followUp(item: AgentCommand): void {
    if (this.current && this.client && this.sessionId) {
      const prompt = itemPrompt(item, { names: this.names, notes: [], turnPrefix: this.turnPrefix });
      const accepted = this.followUps;
      void this.client.sessionSteer(this.sessionId, prompt).then(() => {
        accepted.push(item);
      }).catch(error => {
        console.warn('[body] follow-up remains queued:', error);
      });
    }
  }

  /**
   * Hand one item to the session and wait for its answer. Throws only when
   * the harness itself fails; the runner then completes the item silently.
   */
  async deliver(item: AgentCommand, queued: readonly AgentCommand[], batch: readonly AgentCommand[] = []): Promise<Answer> {
    // start() ran first; a session that died since fails its prompt.
    const client = this.client!;
    const sessionId = this.sessionId!;
    this.current = item;
    if (item.roomId === this.options.placeId) this.squireRelay.activate(item, item.id);
    this.followUps = [];
    const model = await this.optional('Hosted model credential', () => this.hostedModel(item), undefined);
    await this.optional('Tool context', () => this.writeContext(item, [...batch.slice(1), ...queued], model?.paths().directory), undefined);
    const options = { names: this.names, notes: this.notes, turnPrefix: this.turnPrefix };
    const prompt = batch.length ? offlineBatchPrompt(batch, options) : itemPrompt(item, options);
    this.notes = [];
    const stream = new AgentTurnStream({
      api: this.options.api, agentId: this.options.agent.publicKey, roomId: item.roomId,
      requestId: item.turnRequestId, commandId: item.id, label: `place ${item.roomId}`,
    });
    let result: PromptResult;
    try {
      const answering = client.sessionPrompt(sessionId, prompt, stream.onChunk);
      this.resources.refresh();
      for (const next of queued) this.followUp(next);
      result = await answering;
    } catch (error) {
      void stream.retract();
      throw error;
    } finally {
      stream.close();
      this.squireRelay.deactivate(item.turnRequestId);
      this.current = undefined;
    }
    if (this.privateHomeRoot && agentBehavior(this.options.config.agentKind).sharedLoginWriteBack)
      void writeBackRoomClaudeLogin({ root: this.privateHomeRoot, operatorHome: this.options.config.operatorHome })
        .catch(error => console.warn('[body] refreshed Claude login not shared:', error));
    const text = durableReplyText(result.agentText) || durableReplyText(stream.lastRunText);
    let steps: Answer['steps'] = [];
    try { steps = roomReplySteps(agentTurnSteps(result.updates ?? [])); }
    catch (error) { console.warn('[body] optional answer history omitted:', error); }
    return {
      text,
      followUps: this.followUps,
      steps,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      cleanup: async () => {
        model?.revoke();
        return stream.retract();
      },
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
    const homeRoot = this.privateHomeRoot;
    this.privateHomeRoot = undefined;
    this.client = undefined;
    this.sessionId = undefined;
    this.claudeLoginWatch?.close();
    this.claudeLoginWatch = undefined;
    if (client) {
      this.stopping = true;
      try { await stopAgentProcess(client); }
      finally { this.stopping = false; HostPlaces.leave(this.options.placeId); }
    }
    if (homeRoot && this.options.config.agentHomeRoot && homeRoot !== resolve(this.options.config.agentHomeRoot))
      void rm(homeRoot,{recursive:true,force:true}).catch(error=>console.warn('[body] private home cleanup skipped:',error));
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
