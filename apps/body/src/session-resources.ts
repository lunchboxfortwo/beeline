import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentCommand, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { AgentModelConfigOption } from './model-types.js';
import { brokerRequest } from './registry-mcp.js';

type Context = {
  modelCatalog: AgentModelConfigOption[];
  configuration: DaemonOperationMap['getAgentConfiguration']['output'];
  roster: DaemonOperationMap['getWorkspaceRoster']['output'];
  repository: DaemonOperationMap['getRoomRepositoryState']['output'];
  restore: DaemonOperationMap['getCornerRestoreState']['output'];
  grants: DaemonOperationMap['listAgentGrants']['output'];
  threads: DaemonOperationMap['listRoomCorners']['output'];
};

/** Exact tool names take precedence so unrelated descriptions do not inflate discovery. */
function toolsMatching(result: unknown, query: unknown): unknown {
  const search = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const list = (result as { tools?: unknown } | null)?.tools;
  if (!search || !Array.isArray(list)) return result;
  const field = (tool: unknown, key: string) => {
    const value = (tool as Record<string, unknown> | null)?.[key];
    return typeof value === 'string' ? value.toLowerCase() : '';
  };
  const exact = list.filter((tool) => field(tool, 'name') === search);
  const terms = search.split(/\s+/);
  const tools = exact.length
    ? exact
    : list.filter((tool) => {
        const text = `${field(tool, 'name')} ${field(tool, 'title')} ${field(tool, 'description')}`;
        return terms.every((term) => text.includes(term));
      });
  return { ...(result as object), tools };
}

export class SessionResources {
  readonly context: Partial<Context> = {};
  private threadsReceivedAt = 0;
  private readonly receivedCommands = new WeakSet<AgentCommand>();
  private commandThreads?: { value: Context['threads']; receivedAt: number };
  readonly status: Partial<Record<keyof Context | 'setup' | 'checkout', string>> = {};
  private readonly connections = new Map<string, Promise<string>>();
  private writes = Promise.resolve();
  private rpcId = 0;

  constructor(
    private readonly options: {
      api: DaemonApiClient;
      agentId: string;
      placeId: string;
      workspaceId: string;
      parentRoomId?: string;
      cachePath: string;
      brokerSocket?: string;
      configured(): Promise<void>;
      /** The `workspace` tool's checkout; returns its result text. */
      checkout?(): Promise<string>;
      squireMcp?(input: { tool?: unknown; args?: unknown }): Promise<unknown>;
      /** A fresh configuration read landed. */
      onConfiguration?(value: Context['configuration'] | undefined): void;
    },
  ) {
    // A cache miss or corrupt cache cannot delay the first message. Grants
    // are never restored: the broker and command runner authorize each use.
    void readFile(options.cachePath, 'utf8')
      .then((text) => {
        const cached = JSON.parse(text) as Partial<Context>;
        for (const key of [
          'configuration',
          'roster',
          'repository',
          'restore',
          'modelCatalog',
          'threads',
        ] as const)
          if (!this.context[key] && cached[key])
            Object.assign(this.context, { [key]: cached[key] });
      })
      .catch(() => {});
  }

  receiveCommand(item: AgentCommand): void {
    this.receivedCommands.add(item);
    if (item.threads) this.commandThreads = { value: item.threads, receivedAt: performance.now() };
  }

  threadsForDelivery(items: readonly AgentCommand[]): Context['threads'] | undefined {
    for (const item of items)
      if (!this.receivedCommands.has(item)) this.receiveCommand(item);
    return this.commandThreads && this.commandThreads.receivedAt > this.threadsReceivedAt
      ? this.commandThreads.value : this.context.threads;
  }

  refresh(): void {
    const { api, agentId, placeId, parentRoomId, workspaceId } = this.options;
    this.refreshConfiguration();
    this.load('roster', () => api.execute('getWorkspaceRoster', { agentId, workspaceId }));
    this.load('repository', () =>
      api.execute('getRoomRepositoryState', { roomId: parentRoomId ?? placeId }),
    );
    this.load('grants', () => api.execute('listAgentGrants', { agentId, roomId: placeId }));
    if (parentRoomId)
      this.load('restore', () => api.execute('getCornerRestoreState', { cornerId: placeId }));
    this.refreshThreads();
  }

  /** Open threads of this place's chat; also re-read after each turn, which may open one. */
  refreshThreads(): Promise<void> {
    const { api, placeId, parentRoomId } = this.options;
    const read = ++this.threadReads;
    return this.load(
      'threads',
      () => api.execute('listRoomCorners', { roomId: parentRoomId ?? placeId, activeOnly: true }),
      () => { this.threadsReceivedAt = performance.now(); },
      () => read === this.threadReads,
    );
  }

  refreshConfiguration(): void {
    const { api, agentId, placeId } = this.options;
    const read = ++this.configurationReads;
    this.load(
      'configuration',
      () => api.execute('getAgentConfiguration', { agentId, roomId: placeId }),
      // Only the newest read speaks for the owner's current choice.
      (value) => {
        if (read === this.configurationReads) this.options.onConfiguration?.(value);
      },
    );
  }

  private configurationReads = 0;
  private threadReads = 0;

  private load<K extends keyof Context>(
    key: K,
    read: () => Promise<Context[K]>,
    loaded?: (value: Context[K]) => void,
    current: () => boolean = () => true,
  ): Promise<void> {
    this.status[key] = 'loading';
    return Promise.resolve()
      .then(read)
      .then((value) => {
        if (current()) {
          this.context[key] = value;
          this.status[key] = 'ready';
          this.persist();
          loaded?.(value);
        }
      })
      .catch((error) => {
        if (current()) this.status[key] = error instanceof Error ? error.message : String(error);
      });
  }

  async prepare(): Promise<void> {
    try {
      await this.options.configured();
      if (this.options.checkout) this.status.checkout = await this.options.checkout();
      this.status.setup = 'ready';
    } catch (error) {
      this.status.setup = String(error);
      throw error;
    }
  }

  rememberModelCatalog(catalog: AgentModelConfigOption[]): void {
    this.context.modelCatalog = catalog;
    this.persist();
  }

  private persist(): void {
    const { grants: _grants, ...metadata } = this.context;
    const snapshot = JSON.stringify(metadata);
    this.writes = this.writes
      .catch(() => {})
      .then(() => writePrivateFileAtomically(this.options.cachePath, snapshot));
    void this.writes.catch((error) =>
      console.warn('[body] optional context cache not written:', error),
    );
  }

  read(): unknown {
    return {
      ...this.context,
      status: this.status,
      next: 'read(facet:session,name:prepare) installs optional skills and setup and makes the repository checkout. Unavailable resources are tool errors. Trusty Squire uses app_tool(app:"registry-mcp:squire"). Registry MCP uses app_tool(app:"registry-mcp:<serverName>"); approved paths and devices are available to run_granted_command without remounting this session.',
    };
  }

  /** Registry routes join the existing app_tool surface as soon as they load. */
  async mcp(
    input: { app?: unknown; tool?: unknown; args?: unknown; query?: unknown },
    turn: { roomId: string; requestId: string },
  ): Promise<unknown> {
    if (input.app === 'registry-mcp:squire' && this.options.squireMcp) {
      const result = await this.options.squireMcp(input);
      return input.tool === undefined ? toolsMatching(result, input.query) : result;
    }
    const route = this.context.configuration?.registryMcpRoutes?.find(
      (candidate) =>
        input.app === `registry-mcp:${candidate.serverName}` || input.app === candidate.target,
    );
    if (!route || !this.options.brokerSocket)
      throw new Error(
        'Registry MCP route is not available yet; read(facet:session) shows its load result',
      );
    const send = async (connectionId: string, method: string, params: unknown, id?: number) => {
      const messages = await brokerRequest(this.options.brokerSocket!, {
        connectorId: route.connectorId,
        connectionId,
        turn,
        line: JSON.stringify({
          jsonrpc: '2.0',
          ...(id === undefined ? {} : { id }),
          method,
          params,
        }),
      });
      const reply = messages.map((line) => JSON.parse(line)).find((message) => message.id === id);
      if (reply?.error) throw new Error(String(reply.error.message));
      return reply?.result;
    };
    let connection = this.connections.get(route.connectorId);
    if (!connection) {
      connection = (async () => {
        const id = randomUUID();
        await send(
          id,
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'beeline-session', version: '1' },
          },
          ++this.rpcId,
        );
        await send(id, 'notifications/initialized', {});
        return id;
      })();
      this.connections.set(route.connectorId, connection);
      void connection.catch(() => {
        this.connections.delete(route.connectorId);
      });
    }
    const connectionId = await connection;
    return input.tool === undefined
      ? toolsMatching(await send(connectionId, 'tools/list', {}, ++this.rpcId), input.query)
      : send(
          connectionId,
          'tools/call',
          { name: input.tool, arguments: input.args ?? {} },
          ++this.rpcId,
        );
  }
}
