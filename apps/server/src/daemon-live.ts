import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { helperUsageCodecs } from '@beeline/net/helper-codecs';
import { randomUUID } from 'node:crypto';
import type { TokenAuth } from './auth.js';
import type { ConnectionPresence } from './connection-presence.js';
import { DAEMON_OPERATION_NAMES,type DaemonService,type OwnedModelClaimCapability } from './daemon-service.js';
import type { SqlDatabase } from './database.js';
import { isTransientDatabaseConnectionError } from './database.js';
import { applyHelperOverlay,helperOverlayEnabled,subscribeHelperOverlayDemand } from './helper-overlay.js';
import { helperUsageEnabled } from './helper-usage.js';
import type { HelperVersionGate } from './helper-version-gate.js';
import type { LiveHub } from './live.js';
import { MachineRequestResults } from './machine-request-results.js';
import type { PhoneService } from './phone-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import type { VaultSaveRelay } from './vault-save-relay.js';


export interface DaemonLiveDependencies {
  readonly vaultSaveRelay?: VaultSaveRelay;
  readonly auth: TokenAuth;
  readonly phone: PhoneService;
  readonly daemon: DaemonService;
  readonly live: LiveHub;
  readonly database: SqlDatabase;
  readonly connectionPresence?: ConnectionPresence;
  readonly releaseNotify?: ReleaseNotifier;
  readonly helperVersionGate: HelperVersionGate;
  readonly acquireLiveDbTask: () => Promise<() => void>;
  readonly errors: { database: number; invalid: number; internal: number; overload: number };
  readonly counters: { helperVersionRefusals: number; helperForceUpdates: number };
  readonly registry: DaemonConnectionRegistry;
  readonly operationErrorStatus?: (error: unknown) => number;
  /** True while this server is shutting down: its connections stay held for the successor. */
  readonly shuttingDown: () => boolean;
}

function isRetryableLiveError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300';
}

/**
 * Newest connection wins, per agent, across old per-agent sockets and machine
 * registrations on this server. Across server instances the connection epoch
 * decides: an instance drops its own session once it learns of a newer epoch.
 */
export class DaemonConnectionRegistry {
  readonly #sessions = new Map<string, DaemonAgentSession>();
  readonly #newestEpoch = new Map<string, number>();

  claim(session: DaemonAgentSession): void {
    const previous = this.#sessions.get(session.agentId);
    this.#sessions.set(session.agentId, session);
    if (previous && previous !== session) previous.evict('replaced');
  }

  release(session: DaemonAgentSession): void {
    if (this.#sessions.get(session.agentId) === session) this.#sessions.delete(session.agentId);
  }

  /** Some instance accepted connection `epoch` for this agent. */
  observeEpoch(agentId: string, epoch: number): void {
    if (epoch > (this.#newestEpoch.get(agentId) ?? 0)) this.#newestEpoch.set(agentId, epoch);
    this.#settle(agentId);
  }

  /** This instance's session learned its own epoch. */
  settled(session: DaemonAgentSession): void {
    this.#settle(session.agentId);
  }

  #settle(agentId: string): void {
    const session = this.#sessions.get(agentId);
    const newest = this.#newestEpoch.get(agentId) ?? 0;
    if (session?.epoch !== undefined && session.epoch < newest) session.evict('replaced');
    // Only the newest epoch matters; forget it once no session can be older.
    if (!session) this.#newestEpoch.delete(agentId);
  }
}

/** How a session reaches its helper: a whole old socket, or one registration on a machine socket. */
export interface DaemonSessionTransport {
  send(event: Record<string, unknown>): void;
  isOpen(): boolean;
  /** Ends this agent's session: an old socket closes; a registration is dropped. */
  drop(code: number, reason: string): void;
}

/**
 * One agent's live session: authorization, its queue push, wakes and its own
 * bounded task queue. A machine socket holds one per registered agent, so one
 * agent's overload or failure drops only its own.
 */
export class DaemonAgentSession {
  readonly connectionId = randomUUID();
  epoch: number | undefined;
  readonly #wakeReleases: Array<() => void> = [];
  #tail = Promise.resolve();
  #closed = false;
  readonly #closedSignal = new AbortController();
  #claimed = false;
  #forUpdate = false;
  #ownedModelCapability?: OwnedModelClaimCapability;
  readonly #projections = new Set<Promise<unknown>>();

  readonly #overlayReleases=new Map<string,()=>void>();
  usageOwnerId:string|undefined;
  get usageAccountV1():boolean{return this.presence.usageAccountV1===true&&helperUsageEnabled()&&this.usageOwnerId!==undefined&&this.epoch!==undefined;}
  get overlayV1():boolean{return this.presence.overlayV1===true&&helperOverlayEnabled()&&this.epoch!==undefined;}
  /** Places this agent's queue has named; their room-level wakes reach its helper. */
  readonly #places = new Set<string>();
  #queueSubscribed = false;
  #queuePushing = false;
  #queueRequested = false;

  constructor(
    private readonly deps: DaemonLiveDependencies,
    readonly agentId: string,
    private readonly transport: DaemonSessionTransport,
    private readonly presence: {
      lifecycleId?: string;
      releaseVersion?: string;
      sourceSha?: string;
      available?: boolean;
      overlayV1?: boolean;
      usageAccountV1?:boolean;
      queueV1?:boolean;
      daemonOperationsV1?:boolean;
    } = {},
  ) {
    const { live, database } = deps;
    this.#wakeReleases.push(deps.vaultSaveRelay?.attach(agentId, frame => {
      if (!transport.isOpen()) return false;
      transport.send(frame);
      return true;
    }) ?? (() => {}));
    // A fresh Room (or any Room/corner membership change) inserts a
    // `memberships` row whose live notification is Room-scoped — a Room this
    // daemon has never heard of, so it holds no socket subscription for it.
    // Deliver an agent-directed wake instead so discovery starts now.
    this.#wakeReleases.push(
      live.subscribeAll((event) => {
        if (event.type === 'usage-refresh') {
          if (event.agentId === agentId && transport.isOpen())
            transport.send({ type: 'usage-refresh', ...(event.requestId ? { requestId: event.requestId } : {}) });
          return;
        }
        if (event.type === 'agent-sign-in') {
          // Only this agent's own helper hears its sign-in steps; the
          // link/result answers stay on the server for the waiting phone.
          if (event.agentId !== agentId || !transport.isOpen()) return;
          if (event.step === 'start')
            transport.send({
              type: 'agent-sign-in',
              step: 'start',
              attemptId: event.attemptId,
              cardId: event.cardId,
            });
          else if (event.step === 'code')
            transport.send({
              type: 'agent-sign-in',
              step: 'code',
              attemptId: event.attemptId,
              code: event.code,
            });
          return;
        }
        if (
          event.type !== 'invalidate' ||
          event.targetAgentId !== agentId ||
          !transport.isOpen()
        )
          return;
        if(event.reason==='computer-viewer-activity'&&event.requestId){
          transport.send({type:'share-viewer-activity',sessionId:event.requestId});return;
        }
        if (event.reason === 'connector-assignment') {
          transport.send({ type: 'connector-assignment' });
          return;
        }
        if (event.reason === 'postgres:agent_commands') {
          this.#pushQueue();
          // A command for a corner this helper has not seen carries its parent
          // and opener, exactly as a membership push does.
          if (!event.parentRoomId) return;
        } else if (event.reason === 'agent-config') {
          transport.send({ type: 'config-changed', ...(event.roomId ? { roomId: event.roomId } : {}) });
          return;
        } else if (event.reason !== 'postgres:memberships') return;
        if (event.reason === 'postgres:memberships') this.#pushQueue();
        transport.send({
          type: 'rooms-changed',
          ...(event.roomId ? { roomId: event.roomId } : {}),
          ...(event.parentRoomId ? { parentRoomId: event.parentRoomId } : {}),
          ...(event.openedBy ? { openedBy: event.openedBy } : {}),
          ...(event.archived ? { archived: true } : {}),
          ...(event.removed ? { removed: true } : {}),
        });
      }),
      // Room-level facts about a place in this agent's queue: a repository
      // change or a requested corner close.
      live.subscribeAll((event) => {
        if (event.type !== 'invalidate' || !event.roomId || !this.#places.has(event.roomId) || !transport.isOpen()) return;
        if (event.reason === 'postgres:rooms' && event.repositoryChanged)
          transport.send({ type: 'rooms-changed', roomId: event.roomId, repositoryChanged: true });
        else if (event.closeRequested && ['postgres:rooms', 'postgres:corner_facts', 'postgres:corner_github_cache'].includes(event.reason ?? ''))
          transport.send({ type: 'corner-complete', roomId: event.roomId });
      }),
      live.subscribeResync(() => {
        this.#pushQueue();
        transport.send({ type: 'discovery-wake', reason: 'listener-resync' });
      }),
    );
    const recovery = database.onRecovery?.(() => {
      this.#pushQueue();
      transport.send({ type: 'discovery-wake', reason: 'database-recovered' });
    });
    if (recovery) this.#wakeReleases.push(recovery);
  }

  get subscriptions(): number {
    return this.#queueSubscribed ? 1 : 0;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #projection<T>(read: () => Promise<T>): Promise<T> {
    const pending = read();
    this.#projections.add(pending);
    try { return await pending; }
    finally { this.#projections.delete(pending); }
  }

  /**
   * Record this connection as the agent's newest and hold its presence, from
   * the registration's own lifecycle and release fields. A failed write is
   * logged; the queue push still works.
   */
  async claim(): Promise<void> {
    this.deps.registry.claim(this);
    const presence = this.deps.connectionPresence;
    if (!presence) return;
    try {
      const epoch = await presence.claimConnection(this.agentId, {
        connectionId: this.connectionId,
        ...this.presence,
      });
      this.#claimed = true;
      if (this.#closed) {
        await this.#releaseConnection();
        return;
      }
      this.epoch = epoch;
      const model = await this.deps.daemon.negotiateOwnedModel(this.agentId, this.presence.queueV1 === true);
      this.#ownedModelCapability = model?.capability;
      this.deps.registry.settled(this);

    } catch (error) {
      console.error('[presence] connection claim failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** A newer connection for this agent exists (here or on another server). */
  evict(reason: string): void {
    if (this.#closed) return;
    this.transport.drop(4001, reason);
    this.close();
  }

  /** Queue one frame behind this agent's earlier frames. */
  frame(raw: Record<string, unknown>, _frameBytes: number): void {
    if (this.#closed) return;
    if (['daemon-operation','request-result','request-ack'].includes(String(raw.type))) {
      // Provider work and waitForCornerWake must not hold the serial intake
      // queue or its database semaphore: Stop/subscriptions still need service.
      // This is the same authenticated service adapter as old HTTP ingress.
      void this.#operation(raw);
      return;
    }
    this.#tail = this.#tail.then(async () => {
      if (this.#closed || !this.transport.isOpen()) return;
      if (!this.#closed && this.transport.isOpen()) await this.#process(raw);
    }).catch((error) => {
      const retryable = isRetryableLiveError(error);
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      const kind = retryable ? 'database' : code === '22P02' ? 'invalid' : 'internal';
      this.deps.errors[kind]++;
      console.error('[live] message failed', { kind, error });
    });
  }

  close(forUpdate = false): void {
    if (this.#closed) return;
    this.#forUpdate = forUpdate;
    this.#closed = true;
    this.#closedSignal.abort();
    this.#ownedModelCapability = undefined;
    for (const release of this.#wakeReleases.splice(0)) release();
    for(const release of this.#overlayReleases.values())release();this.#overlayReleases.clear();
    this.deps.registry.release(this);
    void this.#releaseConnection();
  }

  async #releaseConnection(): Promise<void> {
    if (!this.#claimed || this.deps.shuttingDown()) return;
    this.#claimed = false;
    await this.deps.connectionPresence?.releaseConnection(this.agentId, this.connectionId, this.#forUpdate)
      .catch((error) => console.error('[presence] connection release failed',
        error instanceof Error ? error.message : String(error)));
  }

  async #operation(item: Record<string, unknown>): Promise<void> {
    if (typeof item.requestId !== 'string' || !item.requestId) return;
    const results = new MachineRequestResults(this.deps.database);
    const requestId = item.requestId;
    const reply = (result:Record<string,unknown>|undefined) => {
      if (!this.#closed && this.transport.isOpen()) this.transport.send(result
        ? {type:'daemon-operation-result',requestId,...result} : {type:'request-missing',requestId});
    };
    try {
      if(item.type === 'request-result') { reply(await results.read(this.agentId,requestId,this.#closedSignal.signal));return; }
      if(item.type === 'request-ack') { await results.acknowledge(this.agentId,requestId);return; }
      const execute = async () => {
        try {
          const operation = item.operation as keyof DaemonOperationMap;
          if (!DAEMON_OPERATION_NAMES.has(operation)) return { error: 'invalid_daemon_operation', status: 400 };
          const input = operation === 'order' || operation === 'postCornerMessage'
            ? { ...(item.input as object), transportRequestId: requestId } : item.input;
          const result = operation === 'startAgentTurn'
            ? await this.deps.daemon.execute(operation, input as never, this.agentId,undefined,
              this.epoch === undefined ? undefined : {connectionId:this.connectionId,epoch:this.epoch})
            : await this.deps.daemon.execute(operation, input as never, this.agentId,
              operation === 'getModelCredential' ? this.#ownedModelCapability : undefined);
          return { result };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error),
            status: this.deps.operationErrorStatus?.(error) ?? 503 };
        }
      };
      // Queue/message IDs own conversational replay. The optional-tool RPC ledger
      // cannot claim, expire, or refuse an answer before its native write.
      if (['postRoomMessage', 'postCornerMessage', 'order', 'report'].includes(String(item.operation)))
        reply(await execute());
      else reply(await results.execute(this.agentId, requestId, {operation:item.operation,input:item.input}, execute));
    } catch(error) {
      // A refused admission or result write must answer the correlated request.
      // Otherwise a finished harness stays working while publication waits forever.
      // Keep the durable request identity: no failed operation is resubmitted here.
      console.error('[live] machine request failed',error);
      reply({error:error instanceof Error ? error.message : 'machine_request_failed',status:503});
    }
  }

  async #process(item: Record<string, unknown>): Promise<void> {
    void this.deps.connectionPresence?.renewLease().catch(error => console.warn('[presence] refresh failed', error));
    if (item.type === 'subscribe-queue') {
      this.#queueSubscribed = true;
      await this.#readQueue();
      return;
    }
    if (item.type === 'presence') {
      await this.deps.connectionPresence?.announce(undefined, this.agentId, {
        ...(typeof item.lifecycleId === 'string' ? { lifecycleId: item.lifecycleId } : { lifecycleId: this.presence.lifecycleId }),
        ...(typeof item.releaseVersion === 'string' ? { releaseVersion: item.releaseVersion } : {}),
        ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
        ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
      });
      return;
    }
    if(item.type==='usage-operation'){
      const names=['publishAgentUsageAccount','attachAgentUsageAccount','postAgentUsage'] as const;
      if(!this.usageAccountV1||typeof item.requestId!=='string'||!item.requestId||
        !names.includes(item.operation as typeof names[number]))return;
      let input:Record<string,unknown>|undefined;
      try{input=helperUsageCodecs(item.operation as typeof names[number]).params.parse(item.input) as unknown as Record<string,unknown>;}catch{
        this.transport.send({type:'usage-result',requestId:item.requestId,error:'usage_operation_invalid'});return;
      }
      const sourceInput=item.operation==='postAgentUsage'?input?.usageSource:input;
      const control=sourceInput&&typeof sourceInput==='object'?sourceInput as Record<string,unknown>:undefined;
      const source=control?.source&&typeof control.source==='object'?control.source as Record<string,unknown>:undefined;
      try{
        if(!input||input.agentId!==this.agentId||source?.connectionId!==this.connectionId||source.epoch!==this.epoch||
          (item.operation!=='attachAgentUsageAccount'&&control?.ownerId!==this.usageOwnerId))throw new Error('Usage registration source mismatch');
        const operation=item.operation as typeof names[number];
        const rawResult=await this.deps.daemon.execute(operation,input as unknown as DaemonOperationMap[typeof operation]['input'],this.agentId);
        const result=helperUsageCodecs(operation).result.parse(rawResult);
        const reply={type:'usage-result',requestId:item.requestId,result};
        if(!this.#closed&&this.transport.isOpen())this.transport.send(reply);
      }catch{
        if(!this.#closed&&this.transport.isOpen())this.transport.send({type:'usage-result',requestId:item.requestId,error:'usage_operation_refused'});
      }
      return;
    }
    if(item.type==='overlay-update'){
      if(!this.overlayV1||typeof item.requestId!=='string'||this.epoch===undefined)return;
      const result=await applyHelperOverlay(this.deps.database,this.agentId,{connectionId:this.connectionId,epoch:this.epoch},item.frame);
      if(result.event){const event={...result.event,localOrigin:true as const};this.deps.live.publish(event);}
      if(!this.#closed&&this.transport.isOpen())this.transport.send({type:'overlay-ack',requestId:item.requestId,...result.ack});
      return;
    }
  }

  /** Another read follows any change that lands while one is in flight. */
  #pushQueue(): void {
    if (!this.#queueSubscribed || this.#closed) return;
    this.#queueRequested = true;
    if (this.#queuePushing) return;
    void this.#projection(() => this.#readQueue());
  }

  async #readQueue(): Promise<void> {
    if (this.#queuePushing) { this.#queueRequested = true; return; }
    this.#queuePushing = true;
    try {
      do {
        this.#queueRequested = false;
        if (this.#closed || !this.transport.isOpen()) return;
        const page = await this.deps.daemon.execute('getAgentCommands', {}, this.agentId);
        if (this.#closed || !this.transport.isOpen()) return;
        for (const command of page.commands) {
          this.#places.add(command.roomId);
          if (command.parentRoomId) this.#places.add(command.parentRoomId);
          if (this.overlayV1 && !this.#overlayReleases.has(command.roomId)) {
            const roomId = command.roomId;
            this.#overlayReleases.set(roomId, subscribeHelperOverlayDemand(this.deps.database, roomId, demand => {
              if (!this.#closed && this.transport.isOpen()) this.transport.send({ type: 'overlay-demand', ...demand });
            }));
          }
        }
        this.transport.send({ type: 'commands', commandProtocol: page.commandProtocol, commands: page.commands });
      } while (this.#queueRequested);
    } catch (error) {
      console.error('[live] queue push failed', error instanceof Error ? error.message : String(error));
      if (!this.#closed && this.transport.isOpen()) this.transport.send({
        type: 'commands',
        error: error instanceof Error ? error.message : 'daemon_operation_refused',
        status: this.deps.operationErrorStatus?.(error) ?? 503,
      });
    } finally {
      this.#queuePushing = false;
    }
  }
}


export { MACHINE_SOCKET_PROTOCOL } from './machine-connection.js';
