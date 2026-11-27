import { removeRetiredStarterTurnRule } from '@beeline/api-contract/beeline-guides';
import { wall, type AgentCommand, type AgentInvocation, type DaemonOperationMap } from '@beeline/api-contract/daemon';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  AcpClient,
  agentTurnSteps,
  openAcpConversation,
  type AcpPromptBlock,
  type McpServerWire,
  type PromptResult,
  type ToolCallEntry,
} from './acp.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { deliverAttachments } from './attachment-delivery.js';
import { agentGitIdentityEnv } from './agent-git-identity.js';
import {
  harnessLoginWritablePaths,
  harnessStateDirsFromEnv,
  hostImportedMcpDeclarations,
  prepareRoomAgentCredentials,
  prepareRoomAgentHome,
} from './agent-home.js';
import { machineCliProxy, machineCliProxyEndpoint } from './cliproxy.js';
import { HostPlaces, startAgentProcess, stopAgentProcess } from './agent-process.js';
import {
  sessionCredentialMaskPaths,
  harnessHomeStateDirs,
  sandboxMountPlan,
  siblingAgentMaskPaths,
  wrapAgentCommand,
  type SandboxSessionSpec,
} from './bwrap-sandbox.js';
import { codegraphMcpServer } from './codegraph.js';
import { bodyAgentCommand, type BodyConfig } from './config.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { harnessIdentityLabel, sessionNewMcpServers } from './cursor-acp-bridge.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { GrantRunnerEndpoint, GrantRunnerRoom } from './grant-runner.js';
import { harnessEnforcement, roomShellCapability } from './harness-capabilities.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
import { grantedHostRouteWires, grantedSquireHostRouteNames } from './host-mcp-route.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { agentArgsWithModelSelection } from './model-config.js';
import { agentOpenRouterKey } from './openrouter-key-usage.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { installOwnedModelProvider } from './owned-model-install.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { itemPrompt, memberTasks, memberThreads, offlineBatchPrompt } from './place-prompt.js';
import {
  assembleSessionPrompt,
  cornerHasRepositoryWork,
  type PromptSurface,
} from './prompt-assembly.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { roomPermissionDecision, unsandboxedPermissionDecision } from './room-permissions.js';
import { beelineAgentMcpServer, readOnlyMcpServer } from './room-session.js';
import { LiveTurnSteps } from './live-turn-steps.js';
import { roomReplySteps } from './room-turn-steps.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeDirectory } from './runtime.js';
import { bridgeSocketPath } from './session-join/bridge-socket.js';
import { stateDir as joinedSessionStateDir } from './session-join/store.js';
import { SessionResources } from './session-resources.js';
import {
  RunningModelReporter,
  reconcileStartupModel,
  switchLiveModel,
  type RunningModelReport,
} from './session-running-model.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { CLIPROXY_SIGNED_OUT } from './turn-failure-reason.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { WarmTranscript } from './warm-transcript.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { runOwnedFile } from './wait.js';
import { githubGitEnv, prepareWorkspace, roomCheckoutPath } from './workspace-checkout.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import { workspaceDependenciesDir } from './dependency-generation.js';

export interface PlaceSessionOptions {
  agent: { publicKey: string; name: string };
  runtime: AgentRuntimeRecord;
  /** This place's config: its private folder and agent home. */
  config: BodyConfig;
  api: DaemonApiClient;
  placeId: string;
  resetId?: string;
  retirement?: AbortSignal;
  /** Set for a corner. */
  parentRoomId?: string;
  workspaceId: string;
  grantRunner?: GrantRunnerEndpoint;
  grantRunnerFile?: string;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** The harness exited on its own. */
  onExit(): void;
  cancelGrantedCommands?(): void;
}

export interface Answer {
  readonly text: string;
  readonly steps: NonNullable<DaemonOperationMap['postRoomMessage']['input']['steps']>;
  readonly stopReason: string;
  readonly toolCalls: readonly ToolCallEntry[];
  /** Tokens the harness reported for this turn, when it said. */
  readonly tokenUsage?: PromptResult['tokenUsage'];
  /** Remove the live draft; called once the answer is posted. */
  readonly cleanup: () => Promise<void>;
}

/**
 * One live harness conversation for one place (Room, DM or corner) of one
 * agent. Optional context and capabilities load after delivery and are read
 * with session tools; startup uses cached facts or disclosed defaults. A
 * harness failure or empty result cannot complete an unanswered human request.
 */
export class PlaceSession {
  client?: AcpClient;
  sessionId?: string;
  /** Configuration changed; start fresh before the next item. */
  stale = false;
  /** The model selection this session started with, to spot a newer one. */
  private activeSelection?: string;
  private notes: string[] = [];
  /** This session has received the bounded recent window. */
  private windowDelivered = false;
  private turnPrefix = '';
  private surface: PromptSurface = 'room';
  private names = new Map<string, string>();
  private readonly warm: WarmTranscript;
  private readonly squireRelay: SquireTaskRelay;
  /** The item being answered, for run_granted_command. */
  current?: AgentCommand;
  currentInvocation?: AgentInvocation;
  private scratch?: string;
  /** Where received pictures are downloaded for an image-capable harness. */
  private attachmentDir?: string;
  private privateHomeRoot?: string;
  private stopping = false;
  private readonly retirement: AbortSignal;
  private stream?: AgentTurnStream;
  readonly resources: SessionResources;
  private readonly running: RunningModelReporter;
  private readonly resourceAuthPath: string;
  private batchedCommands: readonly AgentCommand[] = [];
  private operatorAgent = false;
  promptSectionIds: readonly string[] = [];

  constructor(readonly options: PlaceSessionOptions) {
    this.retirement = options.retirement ?? new AbortController().signal;
    const root =
      options.config.workspaceRoot ??
      resolve(options.runtime.supervisorRoot, 'places', options.placeId);
    this.resourceAuthPath = resolve(root, options.resetId ? `resource-auth-${options.resetId}.json` : 'resource-auth.json');
    this.resources = new SessionResources({
      api: options.api,
      agentId: options.agent.publicKey,
      placeId: options.placeId,
      workspaceId: options.workspaceId,
      parentRoomId: options.parentRoomId,
      cachePath: resolve(root, 'session-context.json'),
      brokerSocket: options.config.registryMcpBrokerSocket,
      configured: () => this.prepareOptionalHome(),
      checkout: () =>
        prepareWorkspace({
          api: options.api,
          config: options.config,
          supervisorRoot: options.runtime.supervisorRoot,
          workspaceId: options.workspaceId,
          agent: options.agent,
          placeId: options.placeId,
          ...(options.parentRoomId ? { parentRoomId: options.parentRoomId } : {}),
        }),
      squireMcp: (input) => this.requestSquire(input),
      onConfiguration: (configuration) => this.selectionRead(configuration),
    });
    this.running = new RunningModelReporter(options.api, options.agent.publicKey);
    this.warm = new WarmTranscript({ path: resolve(root, 'agent-home', 'warm-transcript.json') });
    const api = options.api;
    const roomId = options.placeId;
    const logged = (label: string) => (error: unknown) => console.error(`[body] ${label}:`, error);
    this.squireRelay = new SquireTaskRelay(
      options.agent.publicKey,
      roomId,
      async (call) =>
        (
          await api.execute('authorizeResourceCall', {
            roomId: call.roomId,
            requestId: call.requestId,
            target: 'squire',
            ...resourceCallFacts({ method: 'tools/call', params: { name: call.tool } }),
          })
        ).allowed === true,
      options.config.operatorHome ?? homedir(),
      undefined,
      (decision) => {
        void api
          .execute('postSquireApprovalDecision', { roomId, ...decision })
          .catch(logged('Squire approval decision not published'));
      },
      (sessionId) => {
        void api
          .execute('endComputerSession', { roomId, sessionId })
          .catch(logged('Squire session end not published'));
      },
      async (lease) => (await api.execute('refreshComputerSession', { roomId, ...lease })).live,
      (url, siteUrl) => {
        void api
          .execute('forgetSquireSignIn', { url, ...(siteUrl ? { siteUrl } : {}) })
          .catch(logged('Squire sign-in removal failed'));
      },
      async (service) =>
        (await api.execute('readAgentWorkbench', { roomId })).apps?.find(
          (app) =>
            app.appKey === service.trim().toLowerCase() &&
            app.transport === 'squire-api' &&
            app.status === 'connected',
        )?.connectionReference,
      () => api.refreshMachineVault(),
    );
  }

  /** What run_granted_command needs from this place. */
  grantPlace(): GrantRunnerRoom {
    const { config, parentRoomId, workspaceId } = this.options;
    return {
      workspaceId,
      cwd: this.folder(),
      writePolicy: () =>
        parentRoomId
          ? { surface: 'corner', ...(this.scratch ? { scratch: this.scratch } : {}) }
          : {
              surface: 'room',
              ...(config.bwrapPath ? { bwrapPath: config.bwrapPath } : {}),
              ...(this.scratch ? { scratch: this.scratch } : {}),
              harnessStateDirs: [config.agentHomeRoot, config.agentPrivateRoot].filter(
                (path): path is string => Boolean(path),
              ),
              maskPaths: sessionCredentialMaskPaths(config, config.operatorHome ?? homedir()),
            },
      turn: () =>
        this.current
          ? {
              requestId: this.current.turnRequestId,
              requester: { pubkey: this.current.source.authorId },
            }
          : undefined,
    };
  }

  /**
   * The owner changed this agent's configuration: read it now, and start the
   * next item fresh. Nothing waits for the read; `selectionRead` switches a
   * session that started before it landed.
   */
  configurationChanged(): void {
    this.stale = true;
    this.resources.refreshConfiguration();
  }

  /**
   * A fresh read names the owner's current selection. A live session that
   * started with an older one (a cached read, or one racing a change) switches
   * its model at once, the same unawaited way startup reconciles, so the next
   * turn runs the new choice without holding delivery.
   */
  private selectionRead(configuration: SessionResources['context']['configuration']): void {
    const selection = this.selectionFrom(configuration);
    const next = JSON.stringify(selection);
    if (this.activeSelection === undefined || this.activeSelection === next) return;
    const { client, sessionId } = this;
    if (!client || !sessionId || !this.alive) {
      this.stale = true;
      return;
    }
    this.activeSelection = next;
    console.log(
      `[body] place ${this.options.placeId}: model selection changed; switching the live session`,
    );
    switchLiveModel({
      client,
      sessionId,
      selection,
      catalog: this.resources.context.modelCatalog ?? [],
      applied: (options) => {
        if (this.client === client) this.resources.rememberModelCatalog(options);
      },
      report: (report) => this.reportRunningModel(client, report),
    });
  }

  /**
   * The queue item carries the owner's choice as the server read it with the
   * item. It outranks any configuration read, and a live session that runs
   * another choice starts fresh before answering, so no turn waits for a read.
   */
  private queuedSelection(item: AgentCommand): void {
    if (!item.modelSelection) return;
    this.queued = item.modelSelection;
    if (
      this.activeSelection !== undefined &&
      this.activeSelection !== JSON.stringify(this.selectionFrom(undefined))
    )
      this.stale = true;
  }

  private queued?: AgentCommand['modelSelection'];

  private selectionFrom(configuration: SessionResources['context']['configuration']) {
    const { config } = this.options;
    const owner = this.queued ?? configuration;
    return {
      model: owner?.model ?? config.modelSelection?.model,
      effort: owner?.effort ?? config.modelSelection?.effort,
      fastMode: owner?.fastMode,
    };
  }

  /** The harness has answered the model setter, applied or refused. */
  private modelSwitch(switching: Promise<void>): Promise<void> {
    return switching;
  }

  /** Only the current session's reports reach the server. */
  private reportRunningModel(client: AcpClient, report: RunningModelReport): void {
    if (this.client === client) this.running.report(report);
  }

  get alive(): boolean {
    return this.client?.isAlive === true && Boolean(this.sessionId);
  }

  /** The folder this session works in, writable inside its sandbox. */
  folder(): string {
    const { config, runtime, placeId, parentRoomId, agent } = this.options;
    if (parentRoomId)
      return agentCornerCheckoutPaths(runtime.supervisorRoot, placeId, agent.publicKey).path;
    return config.workspaceRoot!;
  }

  private async optional<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      this.notes.push(
        `${label} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  command(requestId?: string): AgentCommand | undefined {
    if (!requestId || this.current?.turnRequestId === requestId) return this.current;
    return this.batchedCommands.find(item => item.turnRequestId === requestId);
  }

  /** Make sure a live session serves this place; reuse the running one. */
  async start(item?: AgentCommand): Promise<void> {
    const signal = this.retirement;
    signal.throwIfAborted();
    if (item) {
      this.queuedSelection(item);
      this.operatorAgent = item.operatorAgent === true;
    }
    try {
      if (!this.alive || this.stale) await this.startFresh();
      signal.throwIfAborted();
      await this.prepareGitHubLaunchers();
    } catch (error) {
      if (signal.aborted) void this.stop().catch(console.warn);
      throw error;
    }
  }

  private async startFresh(): Promise<void> {
    await this.stop();
    this.stale = false;
    this.running.reset();
    this.notes = [
      'Trusty Squire uses app_tool(app:"registry-mcp:squire"); discover operate_drive and use_credential there. A direct squire MCP startup failure does not establish that this route is unavailable.',
    ];
    this.windowDelivered = false;
    const sandbox = Boolean(this.options.config.bwrapPath);
    if (!sandbox)
      this.notes.push(
        `The OS sandbox is unavailable. You can read files, edit files only inside ${this.folder()}, and shell commands are refused.`,
      );
    try {
      await this.activate(sandbox);
    } catch (error) {
      if (this.retirement.aborted || !sandbox || this.options.config.agentEnv?.BEELINE_FREE_AGENT_MODEL_TOKEN) throw error;
      await this.stop();
      this.notes.push(
        `The OS sandbox could not start (${error instanceof Error ? error.message : String(error)}). ` +
          `This session runs without it: you can read files, edit files only inside ${this.folder()}, and shell commands are refused.`,
      );
      await this.activate(false);
    }
  }

  private async activate(sandboxed: boolean): Promise<void> {
    const { config, api, agent, runtime, placeId, parentRoomId, workspaceId } = this.options;
    const corner = Boolean(parentRoomId);
    const folder = this.folder();
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const gitCommonDir = corner
      ? agentCornerCheckoutPaths(runtime.supervisorRoot, placeId, agent.publicKey).gitCommonDir
      : undefined;
    const sealedDependencies = gitCommonDir ? resolve(gitCommonDir, workspaceDependenciesDir) : undefined;
    if (sealedDependencies) await mkdir(sealedDependencies, { recursive: true, mode: 0o700 });
    const { configuration, roster, repository, restore } = this.resources.context;
    this.names = new Map((roster?.members ?? []).map((member) => [member.identityId, member.name]));
    const self = roster?.members.find((member) => member.identityId === agent.publicKey);
    const selection = this.selectionFrom(configuration);
    this.activeSelection = JSON.stringify(selection);
    const operatorHome = config.operatorHome ?? homedir();
    const homeOverlay = config.agentHomeRoot
      ? await prepareRoomAgentCredentials({
          root: config.agentHomeRoot,
          failClosed: true,
          agentKind: config.agentKind,
          sharedSkills: config.sharedSkills,
          isReviewer: configuration?.isReviewer === true,
          onDiagnostic: (message) => this.notes.push(message),
          operatorHome: config.operatorHome,
          agentEnv: config.agentEnv,
          cliProxy: machineCliProxyEndpoint(),
        })
      : {};
    this.privateHomeRoot = homeOverlay.HOME ? dirname(homeOverlay.HOME) : undefined;
    const privateHomeRoot = this.privateHomeRoot;
    const command = bodyAgentCommand(config);
    const harnessLabel = harnessIdentityLabel({ kind: config.agentKind, command });
    const agentEnv: Record<string, string> = {
      ...config.agentEnv,
      ...homeOverlay,
      ...(corner ? agentGitIdentityEnv(agent) : {}),
      BEELINE_DAEMON_ROOM_ID: placeId,
      BEELINE_PLACE_RESET_ID: this.options.resetId ?? '',
      ...(this.options.grantRunnerFile ? { BEELINE_GRANT_RUNNER_FILE: this.options.grantRunnerFile } : {}),
      ...(this.options.grantRunner ? {
        BEELINE_GRANT_RUNNER_URL: this.options.grantRunner.url,
        BEELINE_GRANT_RUNNER_TOKEN: this.options.grantRunner.token,
      } : {}),
    };
    const featureBranch =
      restore?.featureBranch ?? `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`;
    const targetBranch = repository?.targetBranch || 'main';
    const repositoryBacked = repository?.resolution === 'repository';
    // Cold context loads after delivery; its absence does not mean no repository.
    const repositoryPending = !repository || repository.resolution === 'unverified';
    // Every start refreshes the launchers in this stable directory before delivery.
    if (corner && privateHomeRoot)
      agentEnv.PATH = [
        resolve(privateHomeRoot, 'beeline-github-bin'),
        agentEnv.PATH ?? process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter);
    const knownModels = this.resources.context.modelCatalog?.find(
      (option) => option.category === 'model',
    );
    const launchSelection =
      selection.model && knownModels?.options.some((option) => option.id === selection.model)
        ? selection
        : selection.model
          ? {}
          : undefined;
    const agentArgs = agentArgsWithModelSelection(
      { kind: config.agentKind, command, args: config.agentArgs ?? [] },
      launchSelection,
    );
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.scratch = tmpDir;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    const attachScratchRoot = homeOverlay.HOME ? dirname(homeOverlay.HOME) : tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    this.attachmentDir = attachScratchRoot ? join(attachScratchRoot, 'attachments') : undefined;
    const sandboxSpec: SandboxSessionSpec = {
      userRuntimeDir: `/run/user/${process.getuid?.() ?? 0}`,
      mode: corner ? 'edit' : 'readonly',
      cwd: folder,
      ...(corner ? { worktreePath: folder } : {}),
      ...(gitCommonDir ? { gitCommonDir } : {}),
      ...(sealedDependencies ? { sealedPaths: [sealedDependencies] } : {}),
      harnessStateDirs: stateDirs,
      harnessHomeStateDirs: homeStateDirs,
      ...(tmpDir ? { tmpDir } : {}),
      hostSocketPaths: [
        config.browserShareHostSocket,
        config.registryMcpBrokerSocket,
        bridgeSocketPath(joinedSessionStateDir(agentEnv)),
      ],
      additionalWritablePaths: [
        ...harnessLoginWritablePaths(config.agentKind, operatorHome),
        ...(corner && config.workspaceRoot ? [config.workspaceRoot] : []),
        ...(attachScratchRoot ? [attachScratchRoot] : []),
      ],
      maskPaths: [
        ...sessionCredentialMaskPaths(config, operatorHome),
        ...siblingAgentMaskPaths(runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey)),
      ],
    };
    const spawnCommand = wrapAgentCommand({
      bwrapPath: sandboxed ? config.bwrapPath : undefined,
      spec: sandboxSpec,
      command,
      args: agentArgs,
    });
    const nativeIoProven = harnessEnforcement(harnessLabel).enforcement !== 'unknown';
    const shellCapability = roomShellCapability(harnessLabel, { osSandbox: sandboxed });
    const inspection =
      (nativeIoProven && corner) || shellCapability === 'runs'
        ? undefined
        : await this.optional(
            'File inspection tools',
            async () => readOnlyMcpServer(config, folder, undefined, undefined, agentEnv.PATH),
            undefined,
          );
    const servers: McpServerWire[] = inspection ? [inspection] : [];
    const agentTools = await this.optional(
      'Beeline tools',
      async () =>
        beelineAgentMcpServer(config, api, {
          roomId: parentRoomId ?? placeId,
          workspaceId,
          ...(corner ? { cornerId: placeId, repositoryBacked: true } : {}),
          reviewer: configuration?.isReviewer === true,
          directMessage: repository?.directParticipants?.length === 2,
          nativeIoProven,
          agentCommand: harnessLabel,
          attachRoot: folder,
          ...(attachScratchRoot ? { attachScratchRoot } : {}),
          ...(corner && !repositoryBacked ? { cornerScratchRoot: folder } : {}),
          operatorAgent: this.operatorAgent,
          resetId: this.options.resetId,
          ...(this.options.grantRunner ? { grantRunner: this.options.grantRunner } : {}),
          ...(this.options.grantRunnerFile
            ? { grantRunnerFile: this.options.grantRunnerFile }
            : {}),
        }),
      undefined,
    );
    if (agentTools) servers.push(agentTools);
    const codegraphFolder =
      !corner && repository?.resolution === 'repository' && repository.remote
        ? roomCheckoutPath({
            roomId: placeId,
            supervisorRoot: runtime.supervisorRoot,
            remote: repository.remote,
            targetBranch: repository.targetBranch || 'main',
          })
        : folder;
    const codegraph = codegraphMcpServer(config, codegraphFolder, { readonly: !corner });
    if (codegraph) servers.push(codegraph);
    // Operator-imported host MCP servers join as routes; the resource façade
    // authorizes every call. Squire has its own registry-mcp:squire route.
    const hostDeclarations = hostImportedMcpDeclarations({
      operatorHome,
      agentKind: config.agentKind,
    });
    const squireRoutes = grantedSquireHostRouteNames(
      Object.keys(hostDeclarations),
      hostDeclarations,
    );
    const hostRoutes = Object.keys(hostDeclarations).filter((name) => !squireRoutes.includes(name));
    if (hostRoutes.length) {
      void writePrivateFileAtomically(
        this.resourceAuthPath,
        JSON.stringify({ ...api.connection(), placeId, resetId: this.options.resetId }),
      ).catch(error => console.warn('[body] resource authorization file could not be written:', error));
      servers.push(
        ...grantedHostRouteWires(
          hostRoutes,
          operatorHome,
          hostDeclarations,
          this.resourceAuthPath,
        ),
      );
    }
    const sessionServers = sessionNewMcpServers<McpServerWire>(harnessLabel, servers, []);
    if (agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN) {
      agentEnv.BEELINE_MODEL_ROOM_ID = placeId;
      await installOwnedModelProvider(agentEnv.PI_CODING_AGENT_DIR);
    }
    await installPiMcpBridge({
      agentCommand: harnessLabel,
      piHome: agentEnv.PI_CODING_AGENT_DIR,
      servers,
    });
    const mountedServers = servers.map((server) => server.name);
    const hostServers = [...CODE_OWNED_HOST_MCP_NAMES];
    const plan = sandboxed ? sandboxMountPlan(sandboxSpec) : undefined;
    const editing = corner && sandboxed;
    const signal = this.retirement;
    signal.throwIfAborted();
    const publishCommands = agentCommandCatalogPublisher({ api, agentId: agent.publicKey, workspaceId });
    const client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))({
      agentCommand: spawnCommand.command,
      harnessCommand: command,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: folder,
      agentLabel: harnessLabel,
      backgroundTasks: corner,
      osSandbox: sandboxed,
      autoApprovePermissions: editing,
      permissionHandler: editing
        ? async () => 'allow'
        : sandboxed
          ? async (request) =>
              roomPermissionDecision(request, {
                mountedServers,
                hostServers,
                shellSandboxed: true,
                ...(attachScratchRoot
                  ? { attachmentsDir: join(attachScratchRoot, 'attachments') }
                  : {}),
                ...(plan ? { sandboxPlan: plan } : {}),
                ...(homeOverlay.HOME ? { sandboxHome: homeOverlay.HOME } : {}),
              })
          : async (request) =>
              unsandboxedPermissionDecision(request, folder, { mountedServers, hostServers }),
      onUsage: (usage) => {
        if (!signal.aborted)
          void postChangedAgentUsage(api, agent.publicKey, usage).catch((error) =>
            console.error('[agent-usage] publish failed', error),
          );
      },
      onCommands: (...args) => { if (!signal.aborted) publishCommands(...args); },
    });
    this.client = client;
    HostPlaces.enter(placeId);
    client.on('exit', () => {
      if (this.client === client && !this.stopping) this.options.onExit();
    });
    await startAgentProcess(client, signal);
    signal.throwIfAborted();
    const brief = restore?.brief;
    this.surface = corner
      ? repository?.resolution === 'none'
        ? 'repo-less-corner'
        : 'code-corner'
      : repository?.directParticipants?.length === 2
        ? 'dm'
        : 'room';
    const storedSoul = configuration?.soul ?? self?.soul;
    const soul = storedSoul && (agentEnv.BEELINE_FREE_AGENT_ID || agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN)
      ? { ...storedSoul, instructions: removeRetiredStarterTurnRule(storedSoul.instructions) }
      : storedSoul;
    const session = assembleSessionPrompt({
      squireAvailable: true,
      surface: this.surface,
      repositoryPending,
      agentName: self?.name ?? agent.name,
      machineHost: { hostname: hostname() },
      ...(soul ? { soul } : {}),
      agentCommand: command,
      ...(brief ? { brief } : {}),
      ...(corner && repositoryBacked ? { worktree: { featureBranch, targetBranch } } : {}),
      ...(!corner && repositoryBacked && repository?.key
        ? { repository: { name: repository.key, branch: targetBranch } }
        : {}),
      ...(configuration?.reviewerHandle ? { reviewerHandle: configuration.reviewerHandle } : {}),
      reviewer: configuration?.isReviewer === true,
      cornerPrepareScript: corner && repositoryBacked && cornerHasRepositoryWork(brief),
      ...(sandboxed && !corner && homeOverlay.HOME ? { writableHome: homeOverlay.HOME } : {}),
      ...(shellCapability === 'runs'
        ? { shell: { available: true } as const }
        : shellCapability === 'refused'
          ? {
              shell: {
                available: false,
                ...(config.shellUnavailableDetail ? { detail: config.shellUnavailableDetail } : {}),
              } as const,
            }
          : {}),
    });
    this.turnPrefix = session.turnPrefix;
    this.promptSectionIds = session.report.map(section => section.id);
    if (corner && (repositoryBacked || repositoryPending))
      this.notes.push(
        `Your copy of the repository is made by the workspace tool; call it before repository work. It goes in ${folder}.`,
      );
    // Native resume retains the old system instructions, including repository bans.
    const fingerprint = JSON.stringify([
      selection,
      soul,
      command,
      config.agentArgs,
      folder,
      sandboxed,
      session.systemPrompt,
      ...(this.options.resetId ? [this.options.resetId] : []),
    ]);
    const mode = editing ? 'edit' : 'readonly';
    const opened = await openAcpConversation({
      client,
      agentCommand: harnessLabel,
      resumeSessionId: this.warm.resumeSessionId(fingerprint),
      cwd: folder,
      mcpServers: sessionServers,
      mode,
      create: () =>
        client.sessionNew({
          cwd: folder,
          mcpServers: sessionServers,
          mode,
          systemPrompt: session.systemPrompt,
        }),
      onResumeFailure: (error) =>
        console.warn('[body] native conversation unavailable; starting cold:', error),
    });
    signal.throwIfAborted();
    this.warm.rememberSession(opened.sessionId, fingerprint);
    this.sessionId = opened.sessionId;
    // The owner asked that a commanded model switch simply take effect
    // (22 Nov 2026): the first prompt after a model change follows the
    // harness's answer to the setter.
    const switching = reconcileStartupModel({
      client,
      sessionId: opened.sessionId,
      raw: opened.raw,
      selection,
      notes: this.notes,
      cached: Boolean(configuration),
      placeId,
      current: () => this.client === client,
      remember: (catalog) => this.resources.rememberModelCatalog(catalog),
      report: (report) => this.reportRunningModel(client, report),
    });
    if (switching) await this.modelSwitch(switching);
    if (agentOpenRouterKey(config.agentKind, selection.model, config.agentEnv))
      console.log(`[body] place ${placeId} uses an OpenRouter key`);
  }

  /** Squire discovery is lazy; a broker read never holds session startup. */
  private async requestSquire(input: { tool?: unknown; args?: unknown }): Promise<unknown> {
    const item = this.current;
    return this.squireRelay.requestMcp({
      roomId: item?.roomId ?? this.options.placeId,
      requestId: item?.turnRequestId ?? '',
      taskId: item?.rootCommandId ?? '',
      itemId: item?.id ?? '',
      method: input.tool === undefined ? 'tools/list' : 'tools/call',
      params: input.tool === undefined ? {} : { name: input.tool, arguments: input.args ?? {} },
    });
  }

  private async prepareOptionalHome(): Promise<void> {
    const { config } = this.options;
    const homeRoot = this.privateHomeRoot ?? config.agentHomeRoot;
    const configuration = this.resources.context.configuration;
    if (homeRoot)
      await prepareRoomAgentHome({
        root: homeRoot,
        failClosed: true,
        operatorHome: config.operatorHome,
        agentKind: config.agentKind,
        sharedSkills: config.sharedSkills,
        agentEnv: config.agentEnv,
        cliProxy: machineCliProxyEndpoint(),
        isReviewer: configuration?.isReviewer === true,
        ...openRouterRoutingInput(
          config,
          { model: configuration?.model ?? config.modelSelection?.model },
          undefined,
          {},
        ),
      });
    await this.prepareGitHubLaunchers();
  }

  private async prepareGitHubLaunchers(): Promise<void> {
    const { config, parentRoomId, placeId } = this.options;
    const homeRoot = this.privateHomeRoot ?? config.agentHomeRoot;
    if (parentRoomId && config.runtimeConfigPath && homeRoot) {
      const which = (name: string) =>
        runOwnedFile('which', [name])
          .then((result) => String(result.stdout).trim())
          .catch(() => undefined);
      const gitBinary = await which('git');
      if (!gitBinary) throw new Error('git is not installed');
      await installCornerGitHubWrappers({
        root: homeRoot,
        runtimeConfigPath: config.runtimeConfigPath,
        roomId: parentRoomId,
        cornerId: placeId,
        cliEntrypoint: process.argv[1]!,
        gitBinary,
        ghBinary: await which('gh'),
        featureBranch:
          this.resources.context.restore?.featureBranch ??
          `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`,
        targetBranch: this.resources.context.repository?.targetBranch || 'main',
        inheritedPath: config.agentEnv.PATH ?? process.env.PATH,
      });
    }
  }

  /**
   * Hand one item to the session and wait for its answer. Throws only when
   * the harness itself fails; only background work may complete silently.
   */
  async deliver(
    item: AgentCommand,
    batch: readonly AgentCommand[] = [],
    invocation?: AgentInvocation,
  ): Promise<Answer> {
    // start() ran first; a session that died since fails its prompt.
    const client = this.client!;
    const sessionId = this.sessionId!;
    const signal = this.retirement;
    await this.refreshFeatureBranch();
    // A stopped machine proxy starts again at the endpoint this session holds; the turn never waits for it.
    void machineCliProxy();
    const options = {
      names: this.names,
      notes: this.notes,
      turnPrefix: this.turnPrefix,
      threads: memberThreads(this.surface, this.resources.threadsForDelivery(batch.length ? batch : [item]), this.options),
      tasks: memberTasks(this.surface, this.resources.tasksForDelivery(batch.length ? batch : [item])),
      fresh: !this.windowDelivered,
    };
    this.windowDelivered = true;
    const prompt =
      batch.length > 1 || item.offlineSeconds !== undefined
        ? offlineBatchPrompt(batch.length ? batch : [item], options)
        : itemPrompt(item, options);
    this.notes = [];
    // A received picture rides inline as before, within MAX_INLINE_IMAGE_BYTES each.
    const pictures = (batch.length ? batch : [item])
      .flatMap((next) => next.source.attachments ?? [])
      .filter((attachment) => attachment.mimeType?.startsWith('image/'));
    const images: AcpPromptBlock[] =
      this.attachmentDir && pictures.length && client.canPromptWithImages()
        ? (
            await deliverAttachments(
              pictures,
              join(this.attachmentDir, item.id.replace(/[^\w-]/g, '_')),
            )
          ).flatMap((entry) =>
            entry.image
              ? [{ type: 'image' as const, data: entry.image.data, mimeType: entry.image.mimeType }]
              : [],
          )
        : [];
    signal.throwIfAborted();
    const stream = this.stream = new AgentTurnStream({
      api: this.options.api,
      agentId: this.options.agent.publicKey,
      roomId: item.roomId,
      requestId: item.turnRequestId,
      commandId: item.id,
      label: `place ${item.roomId}`,
      current: () => !signal.aborted,
      invocation,
      resetId: this.options.resetId,
    });
    const liveSteps = this.options.parentRoomId
      ? new LiveTurnSteps(this.options.api, {
          agentId: this.options.agent.publicKey,
          roomId: item.roomId,
          requestId: item.turnRequestId,
          invocation,
          current: () => !signal.aborted,
        })
      : undefined;
    let result: PromptResult;
    this.current = item;
    this.currentInvocation = invocation;
    if (item.roomId === this.options.placeId) this.squireRelay.activate(item, item.id);
    this.batchedCommands = batch;
    try {
      const answering = client.sessionPrompt(
        sessionId,
        images.length ? [{ type: 'text', text: prompt }, ...images] : prompt,
        stream.onChunk,
        undefined,
        liveSteps?.onToolCalls,
      );
      this.resources.refresh();
      this.running.prompt();
      result = await answering;
      const reply = result.agentText.trim();
      if (CLIPROXY_SIGNED_OUT.exec(reply)?.[0] === reply) throw wall('signed-in', reply);
    } catch (error) {
      void stream.retract();
      throw error;
    } finally {
      stream.close();
      this.squireRelay.deactivate(item.turnRequestId);
      this.current = undefined;
      this.currentInvocation = undefined;
      this.batchedCommands = [];
      if (!signal.aborted) this.resources.refreshThreads();
    }
    const text = durableReplyText(result.agentText);
    let steps: Answer['steps'] = [];
    try {
      const collected = agentTurnSteps(result.updates ?? []);
      steps = roomReplySteps(liveSteps ? await liveSteps.remaining(collected) : collected);
    } catch (error) {
      console.warn('[body] optional answer history omitted:', error);
    }
    return {
      text,
      steps,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
      cleanup: async () => {
        return stream.retract();
      },
    };
  }

  /** Another agent may have pushed this thread's branch; bring an existing
   * checkout onto it. A failure delivers anyway, with one line saying so. */
  private async refreshFeatureBranch(): Promise<void> {
    const { parentRoomId, placeId, api } = this.options;
    const folder = this.folder();
    if (!parentRoomId || !existsSync(resolve(folder, '.git'))) return;
    const branch =
      this.resources.context.restore?.featureBranch ??
      `feature/corner-${placeId.replaceAll('-', '').slice(0, 12)}`;
    try {
      const remote = (
        await runOwnedFile('git', ['-C', folder, 'remote', 'get-url', 'origin'])
      ).stdout
        .toString()
        .trim();
      const env = remote.startsWith('file://')
        ? undefined
        : githubGitEnv((await api.execute('getRoomGitHubToken', { roomId: parentRoomId })).token);
      await syncCornerBranch({
        worktreePath: folder,
        featureBranch: branch,
        ...(env ? { env } : {}),
      });
    } catch (error) {
      this.notes.push(
        `Your branch ${branch} could not be refreshed from origin (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); fetch and sync it yourself before relying on it.`,
      );
    }
  }

  /** Stop: end the running prompt now. A harness may ignore session/cancel,
   * so the process tree, its MCP servers and tools end too; the next item
   * starts a fresh session. */
  cancel(): void {
    this.options.cancelGrantedCommands?.();
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    if (this.current) this.squireRelay.cancel(this.current.turnRequestId);
    void this.stop().catch((error) =>
      console.error('[body] stopped session cleanup failed:', error),
    );
  }

  /** Release the detached session's resources. Process teardown owns its own wait. */
  retire(): void {
    this.stream?.abandon();
    this.options.cancelGrantedCommands?.();
    this.squireRelay.close();
    void this.stop().catch((error) => console.warn('[body] retired session cleanup failed:', error));
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
    if (client) {
      this.stopping = true;
      try {
        await stopAgentProcess(client);
      } finally {
        this.stopping = false;
        HostPlaces.leave(this.options.placeId);
      }
    }
    if (
      homeRoot &&
      this.options.config.agentHomeRoot &&
      homeRoot !== resolve(this.options.config.agentHomeRoot)
    )
      void rm(homeRoot, { recursive: true, force: true }).catch((error) =>
        console.warn('[body] private home cleanup skipped:', error),
      );
  }
}
