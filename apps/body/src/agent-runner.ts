import { dirname, resolve } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { resolveSessionIdleMs } from './agent-process.js';
import { AnswerStore, type StoredAnswer } from './answer-store.js';
import type { BodyConfig } from './config.js';
import { captureConnectionUsage, ConnectorUsageRecorder } from './connector-runner.js';
import { DaemonApiError, isAgentRemovedError, type DaemonApiClient } from './daemon-api-client.js';
import { GrantCommandRunner, GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner.js';
import { openRouterRoutingCacheDir } from './openrouter-routing.js';
import { PlaceSession, type Answer } from './place-session.js';
import { approvedDeviceGrant } from './place-prompt.js';
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
    this.grantRunner = new GrantCommandRunner({ api: options.daemonApi, agentId: this.agent.publicKey });
    this.grantRunnerServer = new GrantRunnerServer(this.grantRunner, (placeId, parentRoomId) => prepareWorkspace({
      api: options.daemonApi, config: this.baseConfig, supervisorRoot: runtime.supervisorRoot,
      workspaceId: runtime.communityId, agent: this.agent, placeId, ...(parentRoomId ? { parentRoomId } : {}),
    }));
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
    const listed = new Set(commands.map(item => item.id));
    void this.resendStoredAnswers(listed);
    for (const place of this.places.values()) {
      // Stop wall: the running item left the queue without an answer from us.
      if (place.running && !listed.has(place.running.id) && !this.answered.has(place.running.id)) place.session.cancel();
      place.waiting = place.waiting.filter(item => listed.has(item.id));
    }
    const known = (item: AgentCommand) => this.answered.has(item.id) || [...this.places.values()]
      .some(place => place.running?.id === item.id || place.waiting.some(waiting => waiting.id === item.id));
    for (const item of commands.filter(item => !known(item))) this.place(item).waiting.push(item);
    for (const placeId of this.places.keys()) void this.pump(placeId);
  }

  /** An answer on disk goes out again; one whose item left the queue is forgotten. */
  private async resendStoredAnswers(listed: ReadonlySet<string>): Promise<void> {
    for (const answer of await this.answers.all()) {
      if (!listed.has(answer.itemId)) {
        await this.answers.remove(answer.itemId);
        this.answered.delete(answer.itemId);
      } else if (!this.answered.has(answer.itemId)) {
        this.answered.add(answer.itemId);
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
    let again = true;
    try {
      if (item.action === 'restart') {
        await Promise.all([...this.places.values()].map(other => other.session.stop()));
        await this.store({ itemId: item.id, roomId: item.roomId, requestId: item.turnRequestId, text: '' });
      } else {
        // A harness that cannot start leaves the item waiting for the next queue update.
        again = false;
        await place.session.start();
        again = true;
        const answer = await place.session.deliver(item, place.waiting);
        // Stop wall: a stopped item gets no answer.
        if (this.latest.some(listed => listed.id === item.id)) await this.store({
          itemId: item.id, roomId: item.roomId, requestId: item.turnRequestId,
          text: answer.text, ...(answer.text && answer.steps.length ? { steps: answer.steps } : {}),
        });
        this.afterAnswer(item, answer);
      }
    } catch (error) {
      // The session died before answering: the item is delivered again once it is back.
      console.error(`[body] place ${placeId} could not answer ${item.id}:`, error);
      if (this.latest.some(listed => listed.id === item.id) && !this.answered.has(item.id)) place.waiting.unshift(item);
      await place.session.stop().catch(stopError => console.warn('[body] session stop failed:', stopError));
    } finally {
      place.running = undefined;
      await place.session.writeContext(undefined, []).catch(contextError => console.warn('[body] turn context not cleared:', contextError));
    }
    if (again) void this.pump(placeId);
  }

  /** Usage and diagnostics follow the answer and never hold it. */
  private afterAnswer(item: AgentCommand, answer: Answer): void {
    void answer.clearDraft();
    captureConnectionUsage(this.connectionUsage, {
      requestId: item.turnRequestId, agentId: this.agent.publicKey,
      ...(item.parentRoomId ? { cornerId: item.roomId } : { roomId: item.roomId }),
    }, answer.toolCalls);
    void this.connectionUsage.flush(this.options.daemonApi, item.turnRequestId);
    const trace = new TurnTrace({ surface: item.parentRoomId ? 'corner' : 'room', agentId: this.agent.publicKey,
      roomId: item.roomId, requestId: item.turnRequestId });
    trace.toolCalls([...answer.toolCalls]);
    const replay = trace.replay();
    void this.options.daemonApi.execute('postAgentTurnReceipt', {
      agentId: this.agent.publicKey, roomId: item.roomId, requestId: item.turnRequestId,
      outcome: answer.text ? 'answered' : 'silent', toolCalls: answer.toolCalls.length,
      ...(replay ? { trace: replay } : {}),
    }).catch(error => console.warn('[body] turn diagnostics not written:', error));
    if (approvedDeviceGrant(answer.toolCalls)) {
      // A device joins a sandbox only when the session starts.
      const place = this.places.get(item.roomId);
      if (place) place.session.stale = true;
    }
  }

  private async store(answer: StoredAnswer): Promise<void> {
    this.answered.add(answer.itemId);
    await this.answers.save(answer);
    await this.post(answer);
  }

  /** Post a stored answer; the item is done on the server only once this lands. */
  private async post(answer: StoredAnswer): Promise<void> {
    const api = this.options.daemonApi;
    try {
      if (answer.text) await api.execute('postRoomMessage', {
        roomId: answer.roomId, requestId: answer.requestId, text: answer.text, presentation: 'message',
        ...(answer.steps ? { steps: answer.steps } : {}),
      });
      else await api.execute('markAgentTurnSilent', { roomId: answer.roomId, requestId: answer.requestId });
      await this.answers.remove(answer.itemId);
    } catch (error) {
      if (error instanceof DaemonApiError && !error.retryable) {
        // Stop and membership walls: the server refused this answer for good.
        console.warn(`[body] answer for ${answer.itemId} refused:`, error.message);
        await this.answers.remove(answer.itemId);
        return;
      }
      // Kept on disk; the next queue update or reconnect sends it again.
      this.answered.delete(answer.itemId);
      console.warn(`[body] answer for ${answer.itemId} not delivered yet:`, error);
    }
  }

  private sessionExited(placeId: string): void {
    const place = this.places.get(placeId);
    if (!place || this.stopped) return;
    // A running item fails out of deliver() and is queued again there.
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
    this.endpoint = await this.grantRunnerEndpoint();
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
      await this.storage.idle().catch(() => undefined);
      await this.grantRunnerServer.close();
    }
  }
}
