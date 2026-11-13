import { dirname, resolve } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { resolveSessionIdleMs } from './agent-process.js';
import { writePrivateFileAtomically } from './atomic-private-file.js';
import { AnswerStore, type StoredAnswer } from './answer-store.js';
import type { BodyConfig } from './config.js';
import { captureConnectionUsage, ConnectorUsageRecorder } from './connector-runner.js';
import { isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { PlaceSession, type Answer } from './place-session.js';
import { PlaceStorage } from './place-storage.js';
import { runtimeIdentity, type AgentRuntimeRecord } from './runtime.js';
import { publishStorageFacts } from './storage-owners.js';
import { TurnTrace, turnTraceDirectory } from './turn-trace.js';
import { workspaceAssetRoot } from './workspace-assets.js';
import { prepareWorkspace } from './workspace-checkout.js';

const SESSION_IDLE_MS = resolveSessionIdleMs();

interface Place {
  session: PlaceSession;
  waiting: AgentCommand[];
  running?: AgentCommand;
  idleTimer?: NodeJS.Timeout;
}

/**
 * One agent's runner. The server keeps the agent's queue; this hands each
 * undone item to the live session for its place, stores the answer, posts it
 * to the item's return address and forgets it once the server has it. Rooms,
 * direct messages and corners all go through the same path.
 */
export class AgentRunner {
  private readonly places = new Map<string, Place>();
  /** Items with an answer on disk or on the wire; never handed to the agent again. */
  private readonly answered = new Set<string>();
  private readonly answers: AnswerStore;
  private readonly stored = new Map<string, StoredAnswer>();
  private readonly posting = new Set<string>();
  private readonly durable = new Set<string>();
  private readonly restored: Promise<void>;
  private readonly connectionUsage = new ConnectorUsageRecorder();
  private readonly storage: PlaceStorage;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private readonly grantRunner: GrantCommandRunner;
  private readonly grantRunnerServer: GrantRunnerServer;
  private grantEndpoint?: Promise<GrantRunnerEndpoint | undefined>;
  private endpoint?: GrantRunnerEndpoint;
  private latest: readonly AgentCommand[] = [];
  private stopped = false;
  private removalReads = 0;
  private wake?: () => void;
  private pendingBootstrap = true;

  constructor(
    private readonly runtime: AgentRuntimeRecord,
    private readonly configPath: string,
    private readonly baseConfig: BodyConfig,
    private readonly options: { daemonApi: DaemonApiClient; onConfigChanged?: () => void | Promise<void> },
  ) {
    const runtimeDir = dirname(configPath);
    this.agent = runtimeIdentity(runtime.agent);
    this.answers = new AnswerStore(resolve(runtimeDir, 'answers'));
    this.restored = this.answers.all().then(answers => {
      for (const answer of answers) {
        this.stored.set(answer.itemId, answer);
        this.durable.add(answer.itemId);
        this.answered.add(answer.itemId);
      }
    });
    this.grantRunner = new GrantCommandRunner({ api: options.daemonApi, agentId: this.agent.publicKey });
    this.grantRunnerServer = new GrantRunnerServer(this.grantRunner, (placeId, parentRoomId) => prepareWorkspace({
      api: options.daemonApi, config: this.baseConfig, supervisorRoot: runtime.supervisorRoot,
      workspaceId: runtime.communityId, agent: this.agent, placeId, ...(parentRoomId ? { parentRoomId } : {}),
    }), async (placeId, input) => {
      const session = this.places.get(placeId)?.session;
      if (!session) throw new Error('This place has no live session');
      if (input.action === 'context') {
        if (input.prepare === true) await session.resources.prepare();
        return session.resources.read();
      }
      if (!session.current) throw new Error('Registry MCP requires the current request');
      return session.resources.mcp(input, { roomId: session.current.roomId, requestId: session.current.turnRequestId });
    });
    this.storage = new PlaceStorage({
      supervisorRoot: runtime.supervisorRoot, runtimeDir, workspaceId: runtime.communityId,
      agentId: this.agent.publicKey, operatorHome: baseConfig.operatorHome, api: options.daemonApi,
      live: placeId => this.places.get(placeId)?.session.alive === true,
    });
    options.daemonApi.setQueueListener(commands => this.queueChanged(commands));
    options.daemonApi.setConfigChangedListener(() => this.configChanged());
    options.daemonApi.setRoomsChangedListener(() => { this.pendingBootstrap = true; this.wake?.(); });
    options.daemonApi.setCornerCompleteListener(cornerId => void this.cornerComplete(cornerId));
  }

  private placeConfig(placeId: string): BodyConfig {
    const runtimeDir = dirname(this.configPath);
    const workspaceRoot = this.runtime.rooms.find(room => room.channelId === placeId)?.root ?? resolve(runtimeDir, 'rooms', placeId);
    return {
      ...this.baseConfig,
      workspaceRoot,
      agentSharedAssetRoot: workspaceAssetRoot(this.runtime.supervisorRoot, this.runtime.communityId),
      agentPrivateRoot: resolve(workspaceRoot, 'agent-private'),
      agentMemoryRoot: resolve(runtimeDir, 'memory'),
      openRouterRoutingCacheDir: openRouterRoutingCacheDir(runtimeDir),
      turnTraceDir: turnTraceDirectory(runtimeDir),
      agentHomeRoot: resolve(workspaceRoot, 'agent-home'),
    };
  }

  private place(item: AgentCommand): Place {
    let place = this.places.get(item.roomId);
    if (place) return place;
    const placeId = item.roomId;
    const created: Place = {
      waiting: [],
      session: new PlaceSession({
        agent: this.agent, runtime: this.runtime, config: this.placeConfig(placeId), api: this.options.daemonApi,
        grantRunnerFile: resolve(dirname(this.configPath), 'session-tools.json'),
        placeId, ...(item.parentRoomId ? { parentRoomId: item.parentRoomId } : {}), workspaceId: this.runtime.communityId,
        ...(this.endpoint ? { grantRunner: this.endpoint } : {}),
        onExit: () => this.sessionExited(placeId),
      }),
    };
    this.places.set(placeId, created);
    this.grantRunner.register(placeId, created.session.grantPlace());
    return created;
  }

  /** The server's whole list of this agent's undone items, oldest first. */
  private queueChanged(commands: readonly AgentCommand[]): void {
    this.latest = commands;
    void this.restored.then(() => this.reconcileQueue()).catch(error => console.error('[body] queue delivery failed:', error));
  }

  private reconcileQueue(): void {
    const commands = this.latest;
    const listed = new Set(commands.map(item => item.id));
    for (const id of this.answered) if (!listed.has(id) && !this.stored.has(id)) this.answered.delete(id);
    void this.resendStoredAnswers(listed);
    for (const place of this.places.values()) {
      // Stop wall: the running item left the queue without an answer from us.
      if (place.running && !listed.has(place.running.id) && !this.answered.has(place.running.id)) place.session.cancel();
      place.waiting = place.waiting.filter(item => listed.has(item.id));
    }
    const known = (item: AgentCommand) => this.answered.has(item.id) || [...this.places.values()]
      .some(place => place.running?.id === item.id || place.waiting.some(waiting => waiting.id === item.id));
    for (const item of commands.filter(item => !known(item))) {
      const place = this.place(item);
      place.waiting.push(item);
      if (place.running) place.session.followUp(item);
    }
    for (const placeId of this.places.keys()) void this.pump(placeId);
  }

  /** A visible queued item gets its stored answer again. Absence alone is not
   * acknowledgement: a membership change can hide an item that is still owed. */
  private async resendStoredAnswers(listed: ReadonlySet<string>): Promise<void> {
    for (const answer of this.stored.values()) {
      if (listed.has(answer.itemId) && !this.posting.has(answer.itemId)) {
        void this.post(answer);
      }
    }
  }

  /** Hand the next waiting item of one place to its session; one at a time per place. */
  private async pump(placeId: string): Promise<void> {
    const place = this.places.get(placeId);
    const item = place && !place.running && !this.stopped ? place.waiting.shift() : undefined;
    if (place && !place.running) this.armIdle(place, Boolean(item));
    if (place && item) await this.deliver(placeId, place, item);
  }

  private async deliver(placeId: string, place: Place, item: AgentCommand): Promise<void> {
    place.running = item;
    let started = false;
    try {
      if (item.action === 'restart') {
        await Promise.all([...this.places.values()].map(other => other.session.stop()));
        await this.store({ itemId: item.id, roomId: item.roomId, requestId: item.turnRequestId, text: '' });
      } else {
        // A harness that cannot start leaves the item waiting for the next queue update.
        await place.session.start();
        started = true;
        void this.options.daemonApi.execute('startAgentTurn', { roomId: item.roomId, requestId: item.turnRequestId })
          .catch(error => console.warn('[body] delivery status not written:', error));
        const answer = await place.session.deliver(item, place.waiting);
        // Stop wall: a stopped item gets no answer.
        for (const answered of [item, ...(answer.followUps ?? [])]) {
          if (this.latest.some(listed => listed.id === answered.id)) await this.store({
            itemId: answered.id, roomId: answered.roomId, requestId: answered.turnRequestId,
            text: answer.text, ...(answer.text && answer.steps.length ? { steps: answer.steps } : {}),
          });
        }
        const consumed = new Set(answer.followUps?.map(next => next.id));
        place.waiting = place.waiting.filter(next => !consumed.has(next.id));
        void Promise.resolve().then(() => this.afterAnswer(item, answer))
          .catch(error => console.warn('[body] answer diagnostics failed:', error));
      }
    } catch (error) {
      console.error(`[body] place ${placeId} could not answer ${item.id}:`, error);
      if (this.latest.some(listed => listed.id === item.id) && !this.answered.has(item.id)) {
        if (started && !this.stopped) await this.store({
          itemId: item.id, roomId: item.roomId, requestId: item.turnRequestId,
          text: `${this.agent.name} stopped while answering this: ${error instanceof Error ? error.message : String(error)}`,
        });
        else {
          place.waiting.unshift(item);
          if (!this.stopped) void this.options.daemonApi.execute('startAgentTurn', {
            roomId: item.roomId, requestId: item.turnRequestId, available: false,
          }).catch(error => console.warn('[body] offline status not written:', error));
        }
      }
      await place.session.stop().catch(stopError => console.warn('[body] session stop failed:', stopError));
    } finally {
      place.running = undefined;
    }
    if (started) void this.pump(placeId);
  }

  /** Usage and diagnostics follow the answer and never hold it. */
  private afterAnswer(item: AgentCommand, answer: Answer): void {
    void answer.clearDraft().catch(error => console.warn('[body] draft cleanup failed:', error));
    captureConnectionUsage(this.connectionUsage, {
      requestId: item.turnRequestId, agentId: this.agent.publicKey,
      ...(item.parentRoomId ? { cornerId: item.roomId } : { roomId: item.roomId }),
    }, answer.toolCalls);
    void this.connectionUsage.flush(this.options.daemonApi, item.turnRequestId)
      .catch(error => console.warn('[body] usage diagnostics failed:', error));
    const trace = new TurnTrace({ surface: item.parentRoomId ? 'corner' : 'room', agentId: this.agent.publicKey,
      roomId: item.roomId, requestId: item.turnRequestId });
    trace.toolCalls([...answer.toolCalls]);
    const replay = trace.replay();
    void this.options.daemonApi.execute('postAgentTurnReceipt', {
      agentId: this.agent.publicKey, roomId: item.roomId, requestId: item.turnRequestId,
      outcome: answer.text ? 'answered' : 'silent', toolCalls: answer.toolCalls.length,
      ...(replay ? { trace: replay } : {}),
    }).catch(error => console.warn('[body] turn diagnostics not written:', error));

  }

  private async store(answer: StoredAnswer): Promise<void> {
    this.answered.add(answer.itemId);
    this.stored.set(answer.itemId, answer);
    this.posting.add(answer.itemId);
    try {
      await this.answers.save(answer);
      this.durable.add(answer.itemId);
      void this.post(answer);
    } catch (error) {
      this.posting.delete(answer.itemId);
      console.error('[body] answer could not be saved:', error);
    }
  }

  /** Post a stored answer; the item is done on the server only once this lands. */
  private async post(answer: StoredAnswer): Promise<void> {
    const api = this.options.daemonApi;
    this.posting.add(answer.itemId);
    try {
      if (!this.durable.has(answer.itemId)) {
        await this.answers.save(answer);
        this.durable.add(answer.itemId);
      }
      if (answer.text) await api.execute('postRoomMessage', {
        roomId: answer.roomId, requestId: answer.requestId, text: answer.text, presentation: 'message',
        ...(answer.steps ? { steps: answer.steps } : {}),
      });
      else await api.execute('markAgentTurnSilent', { roomId: answer.roomId, requestId: answer.requestId });
      this.stored.delete(answer.itemId);
      this.durable.delete(answer.itemId);
      void this.answers.remove(answer.itemId).catch(error => console.warn('[body] answer cleanup failed:', error));
    } catch (error) {
      // A queued item still owns its stored answer, including after a refusal.
      // Only a queue snapshot confirming completion or Stop can discard it.
      console.warn(`[body] answer for ${answer.itemId} not delivered yet:`, error);
    } finally {
      this.posting.delete(answer.itemId);
    }
  }

  private sessionExited(placeId: string): void {
    const place = this.places.get(placeId);
    if (!place || this.stopped) return;
    // deliver() posts the stopped-answer notice for a running item.
    if (!place.running) void place.session.stop().then(() => this.pump(placeId));
  }

  /** One stay-warm countdown per idle session; new work cancels it. */
  private armIdle(place: Place, busy: boolean): void {
    clearTimeout(place.idleTimer);
    if (busy || !place.session.alive) return;
    place.idleTimer = setTimeout(() => {
      if (!place.running && !place.waiting.length) void place.session.stop();
    }, SESSION_IDLE_MS);
    place.idleTimer.unref?.();
  }

  private configChanged(): void {
    for (const [placeId, place] of this.places) {
      place.session.resources.refresh();
      place.session.stale = true;
      if (!place.running) void place.session.stop().then(() => this.pump(placeId));
    }
    void Promise.resolve(this.options.onConfigChanged?.()).catch(error => console.error('[body] config-change refresh failed', error));
  }

  private async cornerComplete(cornerId: string): Promise<void> {
    const place = this.places.get(cornerId);
    if (place && !place.running && !place.waiting.length) {
      await place.session.stop();
      this.places.delete(cornerId);
    }
    await this.storage.reapCorner(cornerId).catch(error => console.warn(`[body] corner ${cornerId} cleanup deferred:`, error));
  }

  /** The `workspace` tool's loopback door, shared with run_granted_command. */
  grantRunnerEndpoint(): Promise<GrantRunnerEndpoint | undefined> {
    return this.grantEndpoint ??= this.grantRunnerServer.start().catch(error => {
      console.error('[body] grant runner unavailable:', error);
      return undefined;
    });
  }

  /** Membership and storage facts; never part of delivery. */
  private async bootstrap(): Promise<'member' | 'not-member' | 'unknown'> {
    const bootstrap = await this.options.daemonApi.execute('getDaemonBootstrap', { agentId: this.agent.publicKey });
    publishStorageFacts(this.runtime.supervisorRoot, bootstrap.storageRooms ?? []);
    if (!bootstrap.workspaceIds.includes(this.runtime.communityId)) {
      this.removalReads += 1;
      return this.removalReads < 2 ? 'unknown' : 'not-member';
    }
    this.removalReads = 0;
    this.storage.sweep(bootstrap.storageRooms ?? []);
    return 'member';
  }

  async run(opts: {
    signal?: AbortSignal;
    onEstablished?: () => void | Promise<void>;
    onProgress?: (status: string, fault?: unknown) => void | Promise<void>;
  } = {}): Promise<'aborted' | 'agent-removed'> {
    void this.grantRunnerEndpoint().then(async endpoint => {
      this.endpoint = endpoint;
      if (endpoint) await writePrivateFileAtomically(resolve(dirname(this.configPath), 'session-tools.json'), JSON.stringify(endpoint));
    }).catch(error => console.warn('[body] session tools unavailable:', error));
    this.options.daemonApi.subscribeQueue();
    let established = false;
    try {
      while (!opts.signal?.aborted) {
        if (this.pendingBootstrap) {
          this.pendingBootstrap = false;
          try {
            const membership = await this.bootstrap();
            if (membership === 'not-member') return 'agent-removed';
            if (membership === 'unknown') this.pendingBootstrap = true;
            if (!established) { established = true; await opts.onEstablished?.(); }
            await opts.onProgress?.(`serving; ${this.places.size} place${this.places.size === 1 ? '' : 's'} with sessions`);
          } catch (error) {
            if (isAgentRemovedError(error)) return 'agent-removed';
            await opts.onProgress?.(`degraded: ${error instanceof Error ? error.message : String(error)}`, error);
          }
        }
        if (opts.signal?.aborted) break;
        await new Promise<void>(done => {
          this.wake = done;
          opts.signal?.addEventListener('abort', () => done(), { once: true });
          if (this.pendingBootstrap) done();
        });
        this.wake = undefined;
      }
      return 'aborted';
    } finally {
      this.stopped = true;
      for (const place of this.places.values()) clearTimeout(place.idleTimer);
      await Promise.all([...this.places.values()].map(place => place.session.dispose().catch(() => undefined)));
      await this.grantRunnerServer.close();
    }
  }
}
