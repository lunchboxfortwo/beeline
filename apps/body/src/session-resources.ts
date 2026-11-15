import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
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
};

/** Optional facts load beside the live session. No caller can wait for a refresh. */
export class SessionResources {
  readonly context: Partial<Context> = {};
  readonly status: Partial<Record<keyof Context | 'setup', string>> = {};
  private readonly connections = new Map<string, Promise<string>>();
  private writes = Promise.resolve();
  private rpcId = 0;

  constructor(private readonly options: {
    api: DaemonApiClient; agentId: string; placeId: string; workspaceId: string;
    parentRoomId?: string; cachePath: string; brokerSocket?: string;
    configured(): Promise<void>;
    squireMcp?(input: { tool?: unknown; args?: unknown }): Promise<unknown>;
  }) {
    // A cache miss or corrupt cache cannot delay the first message. Grants
    // are never restored: the broker and command runner authorize each use.
    void readFile(options.cachePath, 'utf8').then(text => {
      const cached = JSON.parse(text) as Partial<Context>;
      for (const key of ['configuration', 'roster', 'repository', 'restore', 'modelCatalog'] as const)
        if (!this.context[key] && cached[key]) Object.assign(this.context, { [key]: cached[key] });
    }).catch(() => {});
  }

  refresh(): void {
    const { api, agentId, placeId, parentRoomId, workspaceId } = this.options;
    this.load('configuration', () => api.execute('getAgentConfiguration', { agentId, roomId: placeId }));
    this.load('roster', () => api.execute('getWorkspaceRoster', { agentId, workspaceId }));
    this.load('repository', () => api.execute('getRoomRepositoryState', { roomId: parentRoomId ?? placeId }));
    this.load('grants', () => api.execute('listAgentGrants', { agentId, roomId: placeId }));
    if (parentRoomId) this.load('restore', () => api.execute('getCornerRestoreState', { cornerId: placeId }));
  }

  private load<K extends keyof Context>(key: K, read: () => Promise<Context[K]>): void {
    this.status[key] = 'loading';
    void Promise.resolve().then(read).then(value => {
      this.context[key] = value;
      this.status[key] = 'ready';
      this.persist();
    }).catch(error => { this.status[key] = error instanceof Error ? error.message : String(error); });
  }

  async prepare(): Promise<void> {
    try { await this.options.configured(); this.status.setup = 'ready'; }
    catch (error) { this.status.setup = String(error); throw error; }
  }

  rememberModelCatalog(catalog: AgentModelConfigOption[]): void {
    this.context.modelCatalog = catalog;
    this.persist();
  }

  private persist(): void {
    const { grants: _grants, ...metadata } = this.context;
    const snapshot = JSON.stringify(metadata);
    this.writes = this.writes.catch(() => {}).then(() => writePrivateFileAtomically(this.options.cachePath, snapshot));
    void this.writes.catch(error => console.warn('[body] optional context cache not written:', error));
  }

  read(): unknown {
    return { ...this.context, status: this.status,
      next: 'read(facet:session,name:prepare) installs optional skills and setup. Unavailable resources are tool errors. Trusty Squire uses app_tool(app:"registry-mcp:squire"). Registry MCP uses app_tool(app:"registry-mcp:<serverName>"); approved paths and devices are available to run_granted_command without remounting this session.' };
  }

  /** Registry routes join the existing app_tool surface as soon as they load. */
  async mcp(input: { app?: unknown; tool?: unknown; args?: unknown }, turn: { roomId: string; requestId: string }): Promise<unknown> {
    if (input.app === 'registry-mcp:squire' && this.options.squireMcp)
      return this.options.squireMcp(input);
    const route = this.context.configuration?.registryMcpRoutes?.find(candidate =>
      input.app === `registry-mcp:${candidate.serverName}` || input.app === candidate.target);
    if (!route || !this.options.brokerSocket) throw new Error('Registry MCP route is not available yet; read(facet:session) shows its load result');
    const send = async (connectionId: string, method: string, params: unknown, id?: number) => {
      const messages = await brokerRequest(this.options.brokerSocket!, {
        connectorId: route.connectorId, connectionId, turn,
        line: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
      });
      const reply = messages.map(line => JSON.parse(line)).find(message => message.id === id);
      if (reply?.error) throw new Error(String(reply.error.message));
      return reply?.result;
    };
    let connection = this.connections.get(route.connectorId);
    if (!connection) {
      connection = (async () => {
        const id = randomUUID();
        await send(id, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'beeline-session', version: '1' } }, ++this.rpcId);
        await send(id, 'notifications/initialized', {});
        return id;
      })();
      this.connections.set(route.connectorId, connection);
      void connection.catch(() => { this.connections.delete(route.connectorId); });
    }
    const connectionId = await connection;
    return input.tool === undefined ? send(connectionId, 'tools/list', {}, ++this.rpcId)
      : send(connectionId, 'tools/call', { name: input.tool, arguments: input.args ?? {} }, ++this.rpcId);
  }
}
